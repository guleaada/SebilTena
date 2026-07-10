// ---------------------------------------------------------------------------
// SCAN STATISTICS (M5.7) — the ONE place counterfeit rates are computed.
//
// Rates are computed over RESOLVED scans only. A Tier-2 CONFIRM row is "pending"
// until the farmer answers YES/NO; an unresolved CONFIRM (farmer walked away) is
// EXCLUDED from every rate — it would otherwise inflate the denominator.
//
// The "effective verdict" of a scan:
//   - CONFIRM + resolved_status set -> resolved_status (the answer)
//   - CONFIRM + resolved_status NULL -> excluded (pending)
//   - anything else                  -> result_status
//
// Counterfeit-suspicion layer = UNREGISTERED + REJECTED_BY_USER. REJECTED_BY_USER
// is a real signal: the label fuzzy-matched a registered product but the person
// holding the bottle says it isn't that product. See DECISIONS.md / M7.
// ---------------------------------------------------------------------------

// Product-identification outcomes that count toward the scan denominator.
// EMERGENCY (first-aid delivery) is logged to `scans` but is NOT a product scan.
const PRODUCT_VERDICTS = new Set([
  "VERIFIED", "UNREGISTERED", "EXPIRED", "BANNED", "SUSPENDED", "UNCONFIRMED", "REJECTED_BY_USER",
]);
const COUNTERFEIT_SUSPICION = new Set(["UNREGISTERED", "REJECTED_BY_USER"]);

export function effectiveStatus(row) {
  if (row.result_status === "CONFIRM") {
    return row.resolved_status == null ? null : row.resolved_status; // null = pending -> excluded
  }
  return row.result_status;
}

export async function scanStats(dbClient, { region } = {}) {
  const args = [];
  let sql = "SELECT result_status, resolved_status FROM scans";
  if (region) { sql += " WHERE region = ?"; args.push(region); }
  const res = await dbClient.execute({ sql, args });

  const stats = { resolvedScans: 0, counterfeitSuspicion: 0, unresolvedConfirm: 0, byStatus: {} };
  for (const row of res.rows) {
    if (row.result_status === "CONFIRM" && row.resolved_status == null) {
      stats.unresolvedConfirm++;
      continue; // pending -> excluded from all rate math
    }
    const eff = effectiveStatus(row);
    if (!PRODUCT_VERDICTS.has(eff)) continue; // e.g. EMERGENCY -> not a product scan
    stats.resolvedScans++;
    stats.byStatus[eff] = (stats.byStatus[eff] || 0) + 1;
    if (COUNTERFEIT_SUSPICION.has(eff)) stats.counterfeitSuspicion++;
  }
  stats.counterfeitRate = stats.resolvedScans ? stats.counterfeitSuspicion / stats.resolvedScans : 0;
  return stats;
}
