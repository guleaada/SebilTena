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

  // ---- Wire hardening: `scans` is the safety-audit + surveillance source, ----
  // ---- so unauthenticated sync input must be clamped to the documented   ----
  // ---- contract (SAFETY.md "scans is verdicts only").                    ----
  console.log("\nWire hardening — verdicts-only vocabulary enforced at the boundary");
  const rowOf = async (u) => (await db.execute({ sql: "SELECT * FROM scans WHERE client_uuid=?", args: [u] })).rows[0];

  const rh = await syncScans([
    { uuid: "h-garbage", result_status: "LANG_FALLBACK_GARBAGE" },
    { uuid: "h-unreg", registration_no_read: "FAKE-0000/00", result_status: "UNREGISTERED", region: "Poison District" },
    { uuid: "h-stale", registration_no_read: "ETH-FUN-0142/17", result_status: "STALE" },
    { uuid: "h-conf", registration_no_read: "ETH-FUN-0142/17", result_status: "CONFIRM", resolved_status: "CONFIRMED_BY_USER" },
    { uuid: "h-badres", result_status: "UNCONFIRMED", resolved_status: "TOTALLY_MADE_UP" },
  ]);
  check("garbage result_status stored as UNCONFIRMED (never raw)", (await rowOf("h-garbage")).result_status === "UNCONFIRMED");
  check("UNREGISTERED rejected from the wire (offline cannot prove counterfeit)", (await rowOf("h-unreg")).result_status === "UNCONFIRMED", JSON.stringify((await rowOf("h-unreg")).result_status));
  check("...but the server's own re-verify records it in synced_status", (await rowOf("h-unreg")).synced_status === "UNREGISTERED");
  check("STALE (offline UI state) stored as UNCONFIRMED", (await rowOf("h-stale")).result_status === "UNCONFIRMED");
  check("offline CONFIRM answer preserved", (await rowOf("h-conf")).resolved_status === "CONFIRMED_BY_USER");
  check("unknown resolved_status dropped to null", (await rowOf("h-badres")).resolved_status == null);
  void rh;

  console.log("\nWire hardening — malformed items are isolated, never wedge the batch");
  const rp = await syncScans([
    { uuid: "h-poison", result_status: "UNCONFIRMED", lat: { evil: true }, lon: "not-a-number" },
    { uuid: "h-after-poison", registration_no_read: "ETH-FUN-0142/17", result_status: "VERIFIED", lat: "8.98", lon: 999 },
    { result_status: "UNCONFIRMED" }, // no uuid at all
  ]);
  check("poison item did not throw; batch completed", rp.inserted >= 1, JSON.stringify(rp));
  check("item after the poison item still inserted", !!(await rowOf("h-after-poison")));
  check("missing uuid counted as rejected", rp.rejected >= 1, JSON.stringify(rp));
  const poisonRow = await rowOf("h-poison");
  check("object lat -> null (typed columns stay typed)", poisonRow && poisonRow.lat == null, JSON.stringify(poisonRow?.lat));
  const afterRow = await rowOf("h-after-poison");
  check("string lat -> null, out-of-range lon -> null", afterRow.lat == null && afterRow.lon == null, JSON.stringify({ lat: afterRow.lat, lon: afterRow.lon }));

  console.log("\nWire hardening — created_at normalized for SQLite TEXT windows");
  await syncScans([{ uuid: "h-date", result_status: "UNCONFIRMED", created_at: "2026-07-05T08:30:00Z" }]);
  const dateRow = await rowOf("h-date");
  check("ISO 'T' normalized to space format", dateRow.created_at === "2026-07-05 08:30:00", JSON.stringify(dateRow.created_at));
  await syncScans([{ uuid: "h-future", result_status: "UNCONFIRMED", created_at: "2999-01-01T00:00:00Z" }]);
  check("future created_at -> server time (not year 2999)", !String((await rowOf("h-future")).created_at).startsWith("2999"));

  console.log("\nPurity — after every sync above, scans still holds ONLY documented verdicts");
  const VOCAB = new Set(["VERIFIED", "UNREGISTERED", "EXPIRED", "BANNED", "SUSPENDED", "UNCONFIRMED", "EMERGENCY", "CONFIRM"]);
  const statuses = (await db.execute("SELECT DISTINCT result_status FROM scans")).rows.map((r) => r.result_status);
  const stray = statuses.filter((s) => !VOCAB.has(s));
  check("no stray result_status reached scans through the wire", stray.length === 0, `stray: ${stray.join(",")}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
