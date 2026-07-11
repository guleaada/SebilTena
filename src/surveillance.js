// ---------------------------------------------------------------------------
// SURVEILLANCE AGGREGATION (M7) — district-level counterfeit signal for
// regulators. This module NEVER returns raw row-level coordinates. Its output
// is aggregated to a district / coarse-grid cell, and a district only shows a
// counterfeit SIGNAL when it clears two floors. See SAFETY.md.
//
// Four defensive principles baked in here:
//   1. The map is a statistical instrument, not an accusation. A single flagged
//      scan is noise; only a CLUSTER (>= minFlagCount, in a district with
//      >= minDistrictScans resolved scans) is signal. Below either floor the
//      district is "insufficient_data" — never flagged, never called clean.
//   2. No raw points leave the server. We bucket to a named `region` where we
//      have one, else snap lat/lon to a COARSE grid and return only the cell
//      CENTROID, labelled approximate. Original coordinates are dropped.
//   3. REJECTED_BY_USER is the noisiest input we have (OCR errors, not confirmed
//      counterfeits). It is returned as its OWN count and is NEVER added into
//      counterfeitRate.
//   4. Every figure carries its sample size + a confidence label, so n=3 is
//      never mistaken for n=300.
// ---------------------------------------------------------------------------
import { db as defaultDb } from "./db.js";
import { config } from "./config.js";
import { effectiveStatus } from "./stats.js";

// Counterfeit signal = a product that the registry says should not be in use.
// EXPIRED is tracked separately (a real product past its date, not a fake).
// REJECTED_BY_USER is tracked separately (noisy). Neither is in the rate.
const FLAG_STATUSES = new Set(["UNREGISTERED", "BANNED"]);

// Resolve a date range to bounds that STRING-COMPARE correctly against
// SQLite's `datetime('now')` output ("YYYY-MM-DD HH:MM:SS", UTC, space-
// separated). Emitting ISO with 'T'/'Z' would mis-order at day boundaries
// (' ' 0x20 < 'T' 0x54), silently dropping same-day scans. Defaults to the
// last `windowDays`.
export function resolveRange({ from, to, windowDays = config.surveillance.windowDays } = {}) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - windowDays * 86400000);
  const sqlite = (d) => (Number.isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").slice(0, 19));
  return { from: sqlite(fromDate), to: sqlite(toDate) };
}

function confidenceLabel(sampleSize) {
  const { indicativeAt, strongAt } = config.surveillance;
  if (sampleSize >= strongAt) return "strong";
  if (sampleSize >= indicativeAt) return "indicative";
  return "provisional";
}

// Bucket a scan to a district key WITHOUT ever exposing its raw coordinates.
// Prefers a named region; falls back to a coarse grid cell (centroid only).
function bucketOf(row, gridSize) {
  if (row.region != null && String(row.region).trim() !== "") {
    const name = String(row.region).trim();
    return { key: `region:${name}`, label: name, granularity: "region", lat: null, lon: null };
  }
  const lat = row.lat == null ? null : Number(row.lat);
  const lon = row.lon == null ? null : Number(row.lon);
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { key: "unlocated", label: "Unlocated", granularity: "none", lat: null, lon: null };
  }
  // Snap to the coarse grid, report the CELL CENTROID (not the point).
  const cellLat = Math.floor(lat / gridSize) * gridSize + gridSize / 2;
  const cellLon = Math.floor(lon / gridSize) * gridSize + gridSize / 2;
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    key: `grid:${round(cellLat)},${round(cellLon)}`,
    label: `~${round(cellLat)}, ${round(cellLon)}`,
    granularity: "grid_approx",
    lat: round(cellLat),
    lon: round(cellLon),
  };
}

/**
 * District-level aggregates over resolved scans in a date window.
 * Returns aggregates ONLY — no raw lat/lon at row granularity ever appears.
 *
 * @returns {Promise<{range, floors, districts: Array}>}
 */
export async function districtAggregates(opts = {}, dbClient = defaultDb) {
  const { minDistrictScans, minFlagCount, minProductCount, gridSize } = config.surveillance;
  const range = resolveRange(opts);

  // Pull only what aggregation needs. created_at bounds the window. We read
  // lat/lon here purely to bucket them server-side; they are discarded after.
  const res = await dbClient.execute({
    sql: `SELECT result_status, resolved_status, region, lat, lon, matched_pesticide_id, created_at
          FROM scans
          WHERE created_at >= ? AND created_at <= ?`,
    args: [range.from, range.to],
  });

  const buckets = new Map();
  for (const row of res.rows) {
    // Skip unresolved CONFIRM (pending) — mirrors stats.js resolved-only rule.
    if (row.result_status === "CONFIRM" && row.resolved_status == null) continue;
    const eff = effectiveStatus(row);
    // Only product-identification verdicts count. EMERGENCY etc. are not scans.
    if (!isProductVerdict(eff)) continue;

    const b = bucketOf(row, gridSize);
    if (!buckets.has(b.key)) {
      buckets.set(b.key, {
        district: b.label,
        granularity: b.granularity,
        lat: b.lat, lon: b.lon, // centroid for grid cells, null for named regions
        resolvedScans: 0,
        unregisteredCount: 0,
        bannedCount: 0,
        expiredCount: 0,
        rejectedByUserCount: 0, // separate, noisy layer — NEVER in the rate
        _products: new Map(),
      });
    }
    const agg = buckets.get(b.key);
    agg.resolvedScans++;
    if (eff === "UNREGISTERED") agg.unregisteredCount++;
    else if (eff === "BANNED") agg.bannedCount++;
    else if (eff === "EXPIRED") agg.expiredCount++;
    else if (eff === "REJECTED_BY_USER") agg.rejectedByUserCount++;

    if (FLAG_STATUSES.has(eff) && row.matched_pesticide_id != null) {
      const pid = String(row.matched_pesticide_id);
      agg._products.set(pid, (agg._products.get(pid) || 0) + 1);
    }
  }

  const districts = [];
  for (const agg of buckets.values()) {
    const flaggedCount = agg.unregisteredCount + agg.bannedCount; // rate numerator
    // counterfeitRate = (unregistered + banned) / resolved. EXPIRED and
    // REJECTED_BY_USER are deliberately excluded.
    const counterfeitRate = agg.resolvedScans ? flaggedCount / agg.resolvedScans : 0;
    // The two floors. Below EITHER -> insufficient data, never a claim.
    const sufficient =
      agg.granularity !== "none" &&
      agg.resolvedScans >= minDistrictScans &&
      flaggedCount >= minFlagCount;

    // Product breakdown, capped so one scan never names a product.
    const topProducts = [...agg._products.entries()]
      .filter(([, c]) => c >= minProductCount)
      .sort((a, b) => b[1] - a[1])
      .map(([pesticideId, count]) => ({ pesticideId: Number(pesticideId), count }));

    districts.push({
      district: agg.district,
      granularity: agg.granularity,
      lat: agg.lat, lon: agg.lon, // centroid only; null for region-level
      resolvedScans: agg.resolvedScans,
      sampleSize: agg.resolvedScans,
      unregisteredCount: agg.unregisteredCount,
      bannedCount: agg.bannedCount,
      expiredCount: agg.expiredCount,
      flaggedCount,
      counterfeitRate: Number(counterfeitRate.toFixed(4)),
      rejectedByUserCount: agg.rejectedByUserCount, // separate layer, not in rate
      confidence: confidenceLabel(agg.resolvedScans),
      sufficient,
      status: sufficient ? "assessed" : "insufficient_data",
      topProducts,
    });
  }

  // Assessed districts first, then by rate — but ordering carries no accusation.
  districts.sort((a, b) => Number(b.sufficient) - Number(a.sufficient) || b.counterfeitRate - a.counterfeitRate);

  return {
    range,
    floors: { minDistrictScans, minFlagCount, minProductCount },
    districts,
  };
}

/** National roll-up. Same resolved-only + separated-rejections rules. */
export async function nationalSummary(opts = {}, dbClient = defaultDb) {
  const { districts, range, floors } = await districtAggregates(opts, dbClient);
  const totals = districts.reduce(
    (t, d) => {
      t.resolvedScans += d.resolvedScans;
      t.unregisteredCount += d.unregisteredCount;
      t.bannedCount += d.bannedCount;
      t.expiredCount += d.expiredCount;
      t.rejectedByUserCount += d.rejectedByUserCount;
      if (d.sufficient) t.assessedDistricts++;
      else t.insufficientDistricts++;
      return t;
    },
    {
      resolvedScans: 0, unregisteredCount: 0, bannedCount: 0, expiredCount: 0,
      rejectedByUserCount: 0, assessedDistricts: 0, insufficientDistricts: 0,
    },
  );
  const flagged = totals.unregisteredCount + totals.bannedCount;
  totals.counterfeitRate = totals.resolvedScans ? Number((flagged / totals.resolvedScans).toFixed(4)) : 0;
  totals.confidence = confidenceLabel(totals.resolvedScans);
  return { range, floors, districtCount: districts.length, totals };
}

// The permanent caption that rides with every export and the map view.
export const SURVEILLANCE_CAPTION =
  "This shows PATTERNS in farmer scan reports — NOT a confirmed record of " +
  "counterfeit sales. Districts below the data threshold are not assessed. " +
  "Aggregated to district level, internal regulator use only.";

// CSV of the aggregates. Carries the caption as header rows; a below-floor
// district emits a BLANK rate (never a rate claim below the floor).
export function districtsCsv({ range, districts }) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  lines.push(`# ${SURVEILLANCE_CAPTION}`);
  lines.push(`# window: ${range.from} .. ${range.to}`);
  lines.push([
    "district", "granularity", "status", "sampleSize", "confidence",
    "counterfeitRate", "unregistered", "banned", "expired", "rejectedByUser",
    "lat_centroid", "lon_centroid",
  ].join(","));
  for (const d of districts) {
    lines.push([
      cell(d.district), d.granularity, d.status, d.sampleSize, d.confidence,
      d.sufficient ? d.counterfeitRate : "", // no rate below the floor
      d.unregisteredCount, d.bannedCount, d.expiredCount, d.rejectedByUserCount,
      d.lat ?? "", d.lon ?? "",
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

// Product-identification verdicts that count toward a district denominator.
function isProductVerdict(eff) {
  return (
    eff === "VERIFIED" || eff === "UNREGISTERED" || eff === "EXPIRED" ||
    eff === "BANNED" || eff === "SUSPENDED" || eff === "UNCONFIRMED" ||
    eff === "REJECTED_BY_USER"
  );
}
