import { db as defaultDb } from "./db.js";
import { verifyNumber as defaultVerify } from "./verify.js";
import { config } from "./config.js";
import { SUPPORTED_LANGS } from "./localize.js";

// ---------------------------------------------------------------------------
// OFFLINE SCAN SYNC (M6 Part C). Flushes queued offline scans to `scans`.
//
// IDEMPOTENT: each queued item carries a client-generated UUID stored in
// `scans.client_uuid` (UNIQUE). INSERT OR IGNORE means a replayed batch adds no
// duplicate rows. Offline verdicts were PROVISIONAL (computed against a possibly
// stale cache), so on sync we re-verify each against the live registry and
// record the authoritative online verdict in `synced_status`. Any change is
// returned as an "upgrade" so the client can notify the farmer — most
// importantly an offline UNCONFIRMED that is really UNREGISTERED. Anonymized:
// only location + product read + verdict; never any identity. See SAFETY.md.
//
// INPUT IS UNAUTHENTICATED WIRE DATA and `scans` is the safety-audit +
// surveillance source, so every field is validated before it is written:
//   - result_status is clamped to the verdicts a client can legitimately hold
//     OFFLINE. `UNREGISTERED` is deliberately NOT accepted from the wire —
//     offline cannot prove counterfeit (SAFETY.md), so an UNREGISTERED claim in
//     a sync batch is either a bug or an attempt to paint a district red; it is
//     stored as UNCONFIRMED and the server's own re-verify records the
//     authoritative verdict in `synced_status`. `STALE` (a legitimate offline
//     UI state, not part of the scans vocabulary) is likewise stored as
//     UNCONFIRMED — conservative, and synced_status is authoritative anyway.
//   - coordinates must be finite numbers in range, else null (SQLite's flexible
//     typing would happily store text in a REAL column).
//   - created_at is normalized to SQLite's space-separated format — scans
//     date-windows are TEXT comparisons against datetime('now'), and an ISO 'T'
//     sorts after ' ', silently pushing same-day rows outside their window.
//   - one malformed item is REJECTED alone; it must never 500 the batch (that
//     would wedge the client's whole queue in an infinite retry).
// ---------------------------------------------------------------------------

// Provisional verdicts a client can legitimately produce offline (+ CONFIRM).
const OFFLINE_STATUSES = new Set(["VERIFIED", "BANNED", "SUSPENDED", "EXPIRED", "UNCONFIRMED", "CONFIRM"]);
// Offline CONFIRM answers only; the online path writes verify verdicts itself.
const RESOLVED_STATUSES = new Set(["CONFIRMED_BY_USER", "REJECTED_BY_USER"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

function cleanStatus(s) {
  const v = String(s || "").toUpperCase();
  if (OFFLINE_STATUSES.has(v)) return v;
  return "UNCONFIRMED"; // STALE, UNREGISTERED, garbage -> conservative default
}
function cleanCoord(v, absMax) {
  // Numbers only — never bind client garbage into a REAL column.
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= absMax ? v : null;
}
function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
// Normalize to "YYYY-MM-DD HH:MM:SS" (UTC) so TEXT comparisons against
// datetime('now') bounds order correctly. Unparseable/future -> null (server time).
function cleanCreatedAt(v, nowMs) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > nowMs + 5 * 60_000) return null;
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
}

export async function syncScans(scans, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const verify = deps.verifyNumber ?? defaultVerify;
  const nowMs = deps.now ? deps.now() : Date.now();
  // A real client's queue is capped at offlineQueueMax; anything far beyond it
  // is not a farmer's backlog. Excess items are rejected, not processed.
  const batchCap = config.offlineQueueMax * 2;

  let inserted = 0;
  let duplicates = 0;
  let rejected = 0;
  const upgrades = [];

  const list = Array.isArray(scans) ? scans : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    try {
      const uuid = cleanStr(s?.uuid, 64);
      if (!uuid || i >= batchCap) { rejected++; continue; }

      const status = cleanStatus(s.result_status);
      const resolved = RESOLVED_STATUSES.has(s.resolved_status) ? s.resolved_status : null;
      const regNoRead = cleanStr(s.registration_no_read, 64);
      const lang = SUPPORTED_LANGS.includes(s.language) ? s.language : null;

      const res = await dbc.execute({
        sql: `INSERT OR IGNORE INTO scans
          (client_uuid, registration_no_read, matched_pesticide_id, result_status,
           resolved_status, confidence, lat, lon, region, language, channel, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`,
        args: [
          uuid,
          regNoRead,
          null, // matched_pesticide_id resolved from the online re-verify below
          status,
          resolved,
          CONFIDENCES.has(s.confidence) ? s.confidence : null,
          cleanCoord(s.lat, 90),
          cleanCoord(s.lon, 180),
          cleanStr(s.region, 64),
          lang,
          "app",
          cleanCreatedAt(s.created_at, nowMs),
        ],
      });

      if (Number(res.rowsAffected || 0) === 0) { duplicates++; continue; } // replay
      inserted++;

      // Re-verify against the LIVE registry (offline verdict was provisional).
      if (regNoRead) {
        const v = await verify(regNoRead, lang || "en");
        await dbc.execute({
          sql: "UPDATE scans SET synced_status = ?, matched_pesticide_id = ? WHERE client_uuid = ?",
          args: [v.status, v.product?.id ?? null, uuid],
        });
        if (v.status !== status) {
          upgrades.push({
            uuid,
            registration_no: regNoRead,
            from: status,
            to: v.status,
            created_at: s.created_at ?? null,
          });
        }
      }
    } catch (err) {
      // One malformed item must never 500 the batch (it would wedge the
      // client's queue in an infinite retry). Reject it and keep going.
      console.error("scan sync item rejected:", err?.message || err);
      rejected++;
    }
  }

  return { inserted, duplicates, rejected, upgrades };
}
