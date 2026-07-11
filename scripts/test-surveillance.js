// M7 Part A — surveillance AGGREGATION tests. Proves the defensive floors and
// that no raw coordinates ever leave the aggregator. Deterministic: wipes and
// seeds `scans` with controlled synthetic rows, no network.
//
//   node scripts/test-surveillance.js
//
import { db, initSchema } from "../src/db.js";
import { districtAggregates, nationalSummary, resolveRange } from "../src/surveillance.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

// Insert one scan row with an explicit created_at (SQLite space format, UTC).
async function insert({ status, resolved = null, region = null, lat = null, lon = null, pid = null, daysAgo = 1 }) {
  const created = new Date(Date.now() - daysAgo * 86400000).toISOString().replace("T", " ").slice(0, 19);
  await db.execute({
    sql: `INSERT INTO scans (result_status, resolved_status, region, lat, lon, matched_pesticide_id, channel, created_at)
          VALUES (?,?,?,?,?,?, 'app', ?)`,
    args: [status, resolved, region, lat, lon, pid, created],
  });
}
async function insertMany(n, opts) { for (let i = 0; i < n; i++) await insert(opts); }
const byName = (dists, name) => dists.find((d) => d.district === name);

async function main() {
  await initSchema();
  await db.execute("DELETE FROM scans");

  // --- "Big District": clears both floors -> assessed -----------------------
  // 5 VERIFIED + 3 UNREGISTERED + 1 BANNED + 2 REJECTED_BY_USER + 1 EXPIRED = 12 resolved.
  await insertMany(5, { status: "VERIFIED", region: "Big District" });
  await insertMany(3, { status: "UNREGISTERED", region: "Big District", pid: 42 });
  await insertMany(1, { status: "BANNED", region: "Big District", pid: 42 });
  await insertMany(2, { status: "REJECTED_BY_USER", region: "Big District" });
  await insertMany(1, { status: "EXPIRED", region: "Big District" });

  // --- "Thin District": ONE unregistered scan -> must NOT flag (key rule) ----
  await insert({ status: "UNREGISTERED", region: "Thin District", pid: 7 });

  // --- "Below Flag District": 15 resolved but only 2 flagged -> insufficient -
  await insertMany(13, { status: "VERIFIED", region: "Below Flag District" });
  await insertMany(2, { status: "UNREGISTERED", region: "Below Flag District" });

  // --- "Confirm District": unresolved CONFIRM must be excluded ---------------
  await insertMany(10, { status: "VERIFIED", region: "Confirm District" });
  await insertMany(4, { status: "CONFIRM", resolved: null, region: "Confirm District" }); // pending -> excluded
  await insert({ status: "CONFIRM", resolved: "UNREGISTERED", region: "Confirm District", pid: 9 }); // resolved -> counts

  const { districts, floors } = await districtAggregates();

  console.log("Floors + assessed district");
  check("minDistrictScans floor is 10", floors.minDistrictScans === 10, JSON.stringify(floors));
  const big = byName(districts, "Big District");
  check("Big District resolvedScans = 12", big.resolvedScans === 12, JSON.stringify(big.resolvedScans));
  check("Big District cleared both floors -> status review_recommended (a lead, not a verdict)", big.sufficient === true && big.status === "review_recommended");
  check("no field asserts the location sells counterfeits", !("counterfeitRate" in big) && !("confirmed" in big) && typeof big.flaggedReportRate === "number", Object.keys(big).join(","));
  check("flaggedReportRate = (unreg+banned)/resolved = 4/12", big.flaggedReportRate === Number((4 / 12).toFixed(4)), JSON.stringify(big.flaggedReportRate));
  check("EXPIRED counted separately, not in rate", big.expiredCount === 1);

  console.log("\nREJECTED_BY_USER is a SEPARATE layer, never in the rate");
  check("rejectedByUserCount = 2", big.rejectedByUserCount === 2, JSON.stringify(big.rejectedByUserCount));
  // If rejections were (wrongly) summed in, the rate would be 6/12 = 0.5, not 0.3333.
  check("rate excludes REJECTED_BY_USER (0.3333, not 0.5)", big.flaggedReportRate !== 0.5 && big.flaggedReportRate === 0.3333);

  console.log("\nThe single most important rule: one bad scan never flags a district");
  const thin = byName(districts, "Thin District");
  check("Thin District (n=1) is insufficient_data", thin.status === "insufficient_data" && thin.sufficient === false, JSON.stringify(thin));
  check("Thin District carries its sample size (1)", thin.sampleSize === 1);

  console.log("\nBoth floors are AND, not OR");
  const bf = byName(districts, "Below Flag District");
  check("15 resolved but only 2 flagged -> insufficient", bf.resolvedScans === 15 && bf.flaggedCount === 2 && bf.sufficient === false, JSON.stringify(bf));

  console.log("\nUnresolved CONFIRM excluded; resolved CONFIRM counts");
  const cd = byName(districts, "Confirm District");
  check("Confirm District resolvedScans = 11 (4 pending excluded)", cd.resolvedScans === 11, JSON.stringify(cd.resolvedScans));
  check("resolved CONFIRM->UNREGISTERED counted as flagged", cd.unregisteredCount === 1);

  console.log("\nEvery district carries sample size + confidence");
  check("all districts have sampleSize", districts.every((d) => typeof d.sampleSize === "number"));
  check("all districts have a confidence label", districts.every((d) => ["provisional", "indicative", "strong"].includes(d.confidence)));
  check("n=12 district is 'provisional'", big.confidence === "provisional");

  console.log("\nConfidence scales with sample size");
  await db.execute("DELETE FROM scans");
  await insertMany(35, { status: "VERIFIED", region: "Indicative District" });
  await insertMany(100, { status: "VERIFIED", region: "Strong District" });
  const conf = (await districtAggregates()).districts;
  check("n=35 -> indicative", byName(conf, "Indicative District").confidence === "indicative");
  check("n=100 -> strong", byName(conf, "Strong District").confidence === "strong");

  console.log("\nNO raw coordinates ever leave the aggregator");
  await db.execute("DELETE FROM scans");
  // Distinct raw points that all snap into the SAME 0.1deg grid cell.
  await insert({ status: "UNREGISTERED", lat: 8.987, lon: 38.761, pid: 3 });
  await insert({ status: "UNREGISTERED", lat: 8.912, lon: 38.799, pid: 3 });
  await insert({ status: "BANNED", lat: 8.955, lon: 38.702, pid: 3 });
  const grid = await districtAggregates();
  const raw = JSON.stringify(grid);
  check("raw input coord 8.987 absent from output", !raw.includes("8.987"));
  check("raw input coord 38.761 absent from output", !raw.includes("38.761"));
  check("raw input coord 8.912 absent from output", !raw.includes("8.912"));
  const cell = grid.districts[0];
  check("grid cell reports a CENTROID, labelled approximate", cell.granularity === "grid_approx" && cell.lat === 8.95 && cell.lon === 38.75, JSON.stringify({ lat: cell.lat, lon: cell.lon }));
  check("three raw points collapsed into one cell (n=3)", cell.resolvedScans === 3);

  console.log("\nDate-range filtering (defaults to 90 days)");
  await db.execute("DELETE FROM scans");
  await insertMany(12, { status: "UNREGISTERED", region: "Recent District", daysAgo: 5, pid: 1 });
  await insertMany(12, { status: "UNREGISTERED", region: "Old District", daysAgo: 400, pid: 1 });
  const def = (await districtAggregates()).districts;
  check("default 90d window excludes a 400-day-old district", !byName(def, "Old District") && !!byName(def, "Recent District"));
  const wide = (await districtAggregates({ windowDays: 500 })).districts;
  check("widening the window includes the old district", !!byName(wide, "Old District"));
  const rr = resolveRange({});
  check("resolveRange emits SQLite-comparable bounds (space, no Z)", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rr.from) && !rr.to.includes("Z"), JSON.stringify(rr));

  console.log("\nNational roll-up");
  // Default 90d window sees only Recent District (12); Old District (400d) excluded.
  const nat = await nationalSummary();
  check("national totals resolvedScans = 12 (default window excludes old)", nat.totals.resolvedScans === 12, JSON.stringify(nat.totals.resolvedScans));
  check("widened national window sums both districts (24)", (await nationalSummary({ windowDays: 500 })).totals.resolvedScans === 24);
  check("national flaggedReportRate present (not a 'counterfeitRate' claim)", typeof nat.totals.flaggedReportRate === "number" && !("counterfeitRate" in nat.totals));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
