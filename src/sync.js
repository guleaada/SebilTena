import { db as defaultDb } from "./db.js";
import { verifyNumber as defaultVerify } from "./verify.js";

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
// ---------------------------------------------------------------------------

export async function syncScans(scans, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const verify = deps.verifyNumber ?? defaultVerify;

  let inserted = 0;
  let duplicates = 0;
  const upgrades = [];

  for (const s of Array.isArray(scans) ? scans : []) {
    if (!s || !s.uuid) continue;

    const res = await dbc.execute({
      sql: `INSERT OR IGNORE INTO scans
        (client_uuid, registration_no_read, matched_pesticide_id, result_status,
         resolved_status, confidence, lat, lon, region, language, channel, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`,
      args: [
        s.uuid,
        s.registration_no_read ?? null,
        null, // matched_pesticide_id resolved from the online re-verify below
        s.result_status ?? "UNCONFIRMED",
        s.resolved_status ?? null,
        s.confidence ?? null,
        s.lat ?? null,
        s.lon ?? null,
        s.region ?? null,
        s.language ?? null,
        "app",
        s.created_at ?? null,
      ],
    });

    if (Number(res.rowsAffected || 0) === 0) { duplicates++; continue; } // replay
    inserted++;

    // Re-verify against the LIVE registry (offline verdict was provisional).
    if (s.registration_no_read) {
      const v = await verify(s.registration_no_read, s.language || "en");
      await dbc.execute({
        sql: "UPDATE scans SET synced_status = ?, matched_pesticide_id = ? WHERE client_uuid = ?",
        args: [v.status, v.product?.id ?? null, s.uuid],
      });
      if (v.status !== s.result_status) {
        upgrades.push({
          uuid: s.uuid,
          registration_no: s.registration_no_read,
          from: s.result_status ?? "UNCONFIRMED",
          to: v.status,
          created_at: s.created_at ?? null,
        });
      }
    }
  }

  return { inserted, duplicates, upgrades };
}
