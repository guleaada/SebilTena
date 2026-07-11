// DEV-ONLY demo seeder for the M7 surveillance map. Wipes `scans` and inserts a
// realistic spread of geotagged, resolved scans across Ethiopian towns so the
// choropleth, floors, confidence tiers and layers are all visible.
//
// NOT part of `npm test` and NOT for production data.
//
//   node scripts/seed-surveillance.js
//
import { db, initSchema } from "../src/db.js";

// [town, lat, lon, {verified, unregistered, banned, expired, rejected}] — counts.
// Rejected are inserted as CONFIRM rows resolved REJECTED_BY_USER (real shape).
const TOWNS = [
  // High counterfeit, well-sampled -> assessed, red.
  ["Adama (East Shewa)", 8.54, 39.27, { verified: 22, unregistered: 12, banned: 3, expired: 2, rejected: 2 }],
  // Clean, well-sampled -> assessed, green (rate low but clears the flag floor).
  ["Bishoftu (East Shewa)", 8.75, 38.98, { verified: 26, unregistered: 3, banned: 1, expired: 1, rejected: 1 }],
  // Elevated + banned cluster, large n -> strong confidence.
  ["Hawassa (Sidama)", 7.05, 38.48, { verified: 78, unregistered: 12, banned: 6, expired: 4, rejected: 5 }],
  // THIN: one flagged scan in a tiny district -> MUST stay insufficient (key rule).
  ["Shashamane (West Arsi)", 7.20, 38.60, { verified: 2, unregistered: 1, banned: 0, expired: 0, rejected: 0 }],
  // Below the FLAG floor: many scans but < 3 flagged -> insufficient (floors are AND).
  ["Bahir Dar (Amhara)", 11.59, 37.39, { verified: 24, unregistered: 2, banned: 0, expired: 8, rejected: 1 }],
  // Rejected-heavy: noisy layer high, but only 1 real flag -> rate insufficient.
  ["Jimma (Oromia SW)", 7.67, 36.83, { verified: 15, unregistered: 1, banned: 0, expired: 1, rejected: 7 }],
  // Very large sample -> strong; moderate rate.
  ["Mekelle (Tigray)", 13.49, 39.47, { verified: 96, unregistered: 14, banned: 4, expired: 3, rejected: 6 }],
  // Banned-product cluster -> assessed.
  ["Dire Dawa", 9.59, 41.86, { verified: 24, unregistered: 4, banned: 6, expired: 2, rejected: 2 }],
];

let PID = 100; // synthetic matched_pesticide_id for flagged rows (product breakdown)

async function insert(status, resolved, lat, lon, pid, daysAgo) {
  const created = new Date(Date.now() - daysAgo * 86400000).toISOString().replace("T", " ").slice(0, 19);
  await db.execute({
    sql: `INSERT INTO scans (result_status, resolved_status, region, lat, lon, matched_pesticide_id, confidence, channel, created_at)
          VALUES (?,?,?,?,?,?,?, 'app', ?)`,
    args: [status, resolved, null, lat, lon, pid, "high", created],
  });
}

async function main() {
  await initSchema();
  await db.execute("DELETE FROM scans");
  let total = 0;
  for (const [town, lat, lon, c] of TOWNS) {
    const pidBanned = PID++, pidUnreg = PID++;
    const push = async (n, status, resolved, pid) => {
      for (let i = 0; i < n; i++) { await insert(status, resolved, lat, lon, pid, 1 + (i % 80)); total++; }
    };
    await push(c.verified, "VERIFIED", null, null);
    await push(c.unregistered, "UNREGISTERED", null, pidUnreg);
    await push(c.banned, "BANNED", null, pidBanned);
    await push(c.expired, "EXPIRED", null, null);
    // Rejected: CONFIRM rows resolved as REJECTED_BY_USER (matches the real pipeline).
    await push(c.rejected, "CONFIRM", "REJECTED_BY_USER", null);
    console.log(`  seeded ${town}`);
  }
  console.log(`\nSeeded ${total} scans across ${TOWNS.length} towns.`);
  process.exit(0);
}
main().catch((e) => { console.error("seed crash:", e); process.exit(1); });
