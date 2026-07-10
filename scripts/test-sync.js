// M6 Part C — offline scan SYNC tests: idempotency (replay adds no duplicate
// rows) + re-verify upgrades (offline UNCONFIRMED -> authoritative UNREGISTERED).
// Deterministic, real seeded DB, no network.
//
//   node scripts/test-sync.js
//
import { db, initSchema } from "../src/db.js";
import { syncScans } from "../src/sync.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const countRows = async () => Number((await db.execute("SELECT COUNT(*) n FROM scans")).rows[0].n);
const rowByUuid = async (u) => (await db.execute({ sql: "SELECT * FROM scans WHERE client_uuid=?", args: [u] })).rows[0];

async function main() {
  await initSchema();
  await db.execute("DELETE FROM scans");

  // Batch: an offline UNCONFIRMED for a fake reg-no + a cached VERIFIED.
  const batch = [
    { uuid: "u-fake-1", registration_no_read: "FAKE-0000/00", result_status: "UNCONFIRMED", confidence: "low", lat: 8.98, lon: 38.76, language: "en", created_at: "2026-07-01T00:00:00Z" },
    { uuid: "u-manc-1", registration_no_read: "ETH-FUN-0142/17", result_status: "VERIFIED", confidence: "high", language: "en", created_at: "2026-07-02T00:00:00Z" },
  ];

  console.log("Sync — insert + re-verify");
  const r1 = await syncScans(batch);
  check("inserted 2", r1.inserted === 2, JSON.stringify(r1));
  check("2 scan rows exist", (await countRows()) === 2);
  check("offline UNCONFIRMED upgraded to UNREGISTERED", r1.upgrades.some((u) => u.uuid === "u-fake-1" && u.from === "UNCONFIRMED" && u.to === "UNREGISTERED"), JSON.stringify(r1.upgrades));
  check("cached VERIFIED stays VERIFIED (no upgrade)", !r1.upgrades.some((u) => u.uuid === "u-manc-1"));
  const fake = await rowByUuid("u-fake-1");
  check("synced_status recorded on the row", fake.synced_status === "UNREGISTERED", JSON.stringify(fake.synced_status));
  check("geotag preserved", Number(fake.lat) === 8.98 && Number(fake.lon) === 38.76);
  check("channel = app", fake.channel === "app");

  console.log("\nIdempotency — replay adds no duplicate rows");
  const before = await countRows();
  const r2 = await syncScans(batch); // exact replay
  check("replay inserted 0", r2.inserted === 0);
  check("replay counted 2 duplicates", r2.duplicates === 2, JSON.stringify(r2));
  check("row count unchanged after replay", (await countRows()) === before);

  console.log("\nDangerous upgrade — offline UNCONFIRMED that is really BANNED");
  const r3 = await syncScans([{ uuid: "u-ban-1", registration_no_read: "ETH-INS-0009/05", result_status: "UNCONFIRMED", language: "en" }]);
  check("banned product surfaces on sync", r3.upgrades.some((u) => u.uuid === "u-ban-1" && u.to === "BANNED"), JSON.stringify(r3.upgrades));

  console.log("\nAnonymity — no identity fields on synced rows");
  const cols = (await db.execute("SELECT * FROM scans LIMIT 1")).rows[0];
  check("no phone/name/identity column present", !("phone" in cols) && !("name" in cols) && !("farmer" in cols), Object.keys(cols).join(","));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
