// M6 offline-safety unit tests. The asymmetric-caching verdict + merge logic is
// SAFETY-CRITICAL, so we test the SAME file the browser runs (public/js/verdict.js)
// by executing it with a fake `window`. Deterministic, no browser.
//
//   node scripts/test-offline.js
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

// Load the browser module with a fake window -> win.OfflineVerdict.
const win = {};
const code = fs.readFileSync(path.join(ROOT, "public", "js", "verdict.js"), "utf8");
// eslint-disable-next-line no-new-func
new Function("window", code)(win);
const { computeVerdict, mergeBundle } = win.OfflineVerdict;

const DAY = 86400000;
const now = new Date("2026-07-10T00:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * DAY).toISOString();
const STALE_AFTER = 90;
const cv = (rec) => computeVerdict(rec, { now, staleAfterDays: STALE_AFTER });

function rec(over = {}) {
  return { registration_no: "ETH-FUN-0142/17", status: "registered", expiry_date: "2027-05-12", checked_at: daysAgo(1), ...over };
}

function main() {
  console.log("computeVerdict — asymmetric caching");

  // Unknown offline -> UNCONFIRMED, NEVER UNREGISTERED.
  const unknown = cv(null);
  check("no cached record -> UNCONFIRMED", unknown.status === "UNCONFIRMED");
  check("no cached record is NEVER UNREGISTERED", unknown.status !== "UNREGISTERED");
  check("UNCONFIRMED shows no dose", unknown.showDose === false);

  // Danger is permanent — even if the cache is ancient.
  check("banned -> BANNED", cv(rec({ status: "banned", checked_at: daysAgo(999) })).status === "BANNED");
  check("suspended -> SUSPENDED", cv(rec({ status: "suspended", checked_at: daysAgo(999) })).status === "SUSPENDED");
  check("banned withholds dose", cv(rec({ status: "banned" })).showDose === false);

  // Expiry re-evaluated vs device clock.
  check("registered + past expiry -> EXPIRED", cv(rec({ expiry_date: "2020-01-01" })).status === "EXPIRED");
  check("EXPIRED withholds dose", cv(rec({ expiry_date: "2020-01-01" })).showDose === false);

  // Fresh vs stale.
  const fresh = cv(rec({ checked_at: daysAgo(10) }));
  check("fresh registered -> VERIFIED", fresh.status === "VERIFIED");
  check("fresh VERIFIED shows dose", fresh.showDose === true);
  check("fresh VERIFIED carries checked_at", !!fresh.checked_at);

  const stale = cv(rec({ checked_at: daysAgo(120) }));
  check("stale (>90d) -> STALE (caution)", stale.status === "STALE");
  check("STALE withholds dose", stale.showDose === false);
  check("STALE is flagged stale", stale.stale === true);

  // Wrong/backdated device clock -> STALE, not fresh (fail toward caution).
  const backdated = computeVerdict(rec({ checked_at: daysAgo(1) }), { now: new Date("2020-01-01T00:00:00Z"), staleAfterDays: STALE_AFTER });
  check("device clock before checked_at -> STALE, not fresh", backdated.status === "STALE" && backdated.clockSuspect === true);

  console.log("\nmergeBundle — sticky danger");

  // Sticky: incoming downgrades a locally-banned reg-no -> stays banned + anomaly.
  const existing = [{ key: "ETHINS000905", registration_no: "ETH-INS-0009/05", status: "banned" }];
  const downgrade = { products: [{ registration_no: "ETH-INS-0009/05", status: "registered" }] };
  const m1 = mergeBundle(existing, downgrade);
  const merged = m1.records.find((r) => r.key === "ETHINS000905");
  check("sync downgrade does NOT un-ban", merged.status === "banned" && merged.sticky_danger === true);
  check("downgrade logs a sticky anomaly", m1.anomalies.some((a) => a.type === "sticky_ban_kept"));

  // Sticky orphan: incoming omits a locally-banned reg-no -> kept + anomaly.
  const m2 = mergeBundle(existing, { products: [{ registration_no: "ETH-FUN-0142/17", status: "registered" }] });
  check("sync omitting a banned product keeps it banned", m2.records.some((r) => r.key === "ETHINS000905" && r.status === "banned"));
  check("omission logs a sticky anomaly", m2.anomalies.some((a) => a.type === "sticky_ban_orphan_kept"));

  // A genuinely-new banned product is added.
  const m3 = mergeBundle([], { products: [{ registration_no: "ETH-INS-0009/05", status: "banned" }] });
  check("new banned product added", m3.records[0].status === "banned" && m3.anomalies.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
