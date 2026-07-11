// M7.5 Part C — anomaly quarantine. Proves (1) the pure batch heuristics, and
// (2) end-to-end that a poisoning burst of invented-number scans from one source
// lands in `pending_review` and does NOT move the live surveillance aggregate,
// while a normal small batch is untouched. Deterministic, no network.
//
//   node scripts/test-quarantine.js
//
import { db, initSchema } from "../src/db.js";
import { syncScans } from "../src/sync.js";
import { districtAggregates } from "../src/surveillance.js";
import { evaluateBatchAnomaly } from "../src/anomaly.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const rev = async (uuid) => (await db.execute({ sql: "SELECT review_status FROM scans WHERE client_uuid=?", args: [uuid] })).rows[0]?.review_status;
const countScans = async () => Number((await db.execute("SELECT COUNT(*) n FROM scans")).rows[0].n);

async function main() {
  await initSchema();

  // ---- Pure heuristics --------------------------------------------------------
  console.log("Batch heuristics (coarse, fail-conservative)");
  const F = (regNoRead, lat, lon) => ({ regNoRead, lat, lon });
  check("empty batch -> no quarantine", evaluateBatchAnomaly([]).quarantine === false);
  check("volume burst (5 flagged) -> quarantine (flag_burst)",
    evaluateBatchAnomaly([F("A1"), F("B2"), F("C3"), F("D4"), F("E5")]).reason === "flag_burst");
  check("uniform reg-nos (shared long prefix) -> quarantine (uniform_regnos)",
    evaluateBatchAnomaly([F("GHOSTX-0001/26"), F("GHOSTX-0002/26"), F("GHOSTX-0003/26")]).reason === "uniform_regnos");
  check("sequential reg-nos -> quarantine (sequential_regnos)",
    evaluateBatchAnomaly([F("AB-1"), F("AB-2"), F("AB-3")]).reason === "sequential_regnos");
  check("tight spatial cluster of flags -> quarantine (clustered_flags)",
    evaluateBatchAnomaly([F("QW-77", 8.50, 38.50), F("ER-88", 8.51, 38.51), F("TY-93", 8.49, 38.49)]).reason === "clustered_flags");
  check("2 flagged, no pattern -> NOT quarantined (below min)",
    evaluateBatchAnomaly([F("AB12/1"), F("CD34/9")]).quarantine === false);
  check("3 distinct, non-patterned, spread out -> NOT quarantined",
    evaluateBatchAnomaly([F("AB12/1", 8.5, 38.5), F("CD34/9", 11.6, 37.4), F("EF56/3", 13.5, 39.5)]).quarantine === false);

  // ---- End-to-end: a poisoning burst does not move the live map ---------------
  console.log("\nPoisoning burst -> quarantined + excluded from the live aggregate");
  await db.execute("DELETE FROM scans");
  // 12 invented reg-numbers, all at ONE chosen coordinate: WITHOUT quarantine this
  // would clear both floors (12 resolved, 12 flagged) and light the district up.
  const burst = Array.from({ length: 12 }, (_, i) => ({
    uuid: `poison-${i}`,
    registration_no_read: `GHOSTSEQ-${String(1000 + i)}/26`, // uniform + sequential invented
    result_status: "UNCONFIRMED",
    lat: 8.55, lon: 39.25,
  }));
  const r = await syncScans(burst);
  check("all 12 flagged scans quarantined", r.quarantined === 12, JSON.stringify(r));
  check("rows are in pending_review (not deleted)", (await rev("poison-0")) === "pending_review");
  check("no rows were auto-deleted", (await countScans()) === 12);

  const agg1 = await districtAggregates({});
  const poisonCell = agg1.districts.find((d) => d.lat === 8.55 && d.lon === 39.25);
  check("the poisoned district does NOT appear in the live aggregate", !poisonCell, JSON.stringify(poisonCell));
  check("held-for-review count surfaced to the admin (12)", agg1.pendingReview === 12, String(agg1.pendingReview));

  // Quarantine is logged, never silent.
  const ev = (await db.execute("SELECT payload FROM events WHERE type='surveillance_quarantine' ORDER BY id DESC LIMIT 1")).rows[0];
  check("quarantine logged to events with a reason + count", ev && JSON.parse(ev.payload).count === 12 && !!JSON.parse(ev.payload).reason, ev && ev.payload);

  // ---- A normal small batch is untouched -------------------------------------
  console.log("\nNormal usage is not quarantined");
  await db.execute("DELETE FROM scans");
  const normal = [
    { uuid: "n-1", registration_no_read: "FAKE-0001/00", result_status: "UNCONFIRMED", region: "Normalville" },
    { uuid: "n-2", registration_no_read: "OTHER-9/9", result_status: "UNCONFIRMED", region: "Normalville" },
  ];
  const rn = await syncScans(normal);
  check("small non-patterned batch -> 0 quarantined", rn.quarantined === 0, JSON.stringify(rn));
  check("normal scans stay live (review_status NULL)", (await rev("n-1")) == null);
  const agg2 = await districtAggregates({});
  check("normal scans DO count in the live aggregate", !!agg2.districts.find((d) => d.district === "Normalville"));

  // ---- Human release re-admits a scan (no auto-decisions) --------------------
  console.log("\nA human release re-admits held scans");
  await db.execute("DELETE FROM scans");
  const b2 = Array.from({ length: 12 }, (_, i) => ({
    uuid: `rel-${i}`, registration_no_read: `HELDSEQ-${String(2000 + i)}/26`,
    result_status: "UNCONFIRMED", region: "ReleaseRegion",
  }));
  await syncScans(b2);
  const before = (await districtAggregates({})).districts.find((d) => d.district === "ReleaseRegion");
  check("held burst absent from live aggregate before release", !before);
  await db.execute("UPDATE scans SET review_status='released' WHERE region='ReleaseRegion'");
  const after = (await districtAggregates({})).districts.find((d) => d.district === "ReleaseRegion");
  check("released scans re-enter the live aggregate", !!after && after.resolvedScans === 12, JSON.stringify(after && after.resolvedScans));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
