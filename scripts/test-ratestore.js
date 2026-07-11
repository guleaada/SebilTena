// M8 Part C — shared-store rate limiter. Proves fixed-window counting, that two
// limiter instances sharing one store enforce a SINGLE budget (multi-machine
// correctness), window reset, TTL cleanup, and the fail-open / fail-closed split
// when the store is unreachable. Deterministic, no network.
//
//   node scripts/test-ratestore.js
//
import { db, initSchema } from "../src/db.js";
import { createSharedRateLimiter, cleanupRateLimits } from "../src/rateStore.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

// A store that always throws, to exercise the failure paths.
const brokenDb = { execute: async () => { throw new Error("store unreachable"); } };

async function main() {
  await initSchema();
  await db.execute("DELETE FROM rate_limits");

  const WIN = 1000; // 1s window for deterministic reset testing
  const lim = createSharedRateLimiter({ prefix: "t", windowMs: WIN, max: 3, dbClient: db });

  console.log("Fixed-window counting");
  check("fresh key not limited", (await lim.isLimited("a", 0)) === false);
  await lim.record("a", 0); await lim.record("a", 0); await lim.record("a", 0);
  check("at the cap -> limited", (await lim.isLimited("a", 0)) === true);
  check("a different key is independent", (await lim.isLimited("b", 0)) === false);

  console.log("\nWindow resets after windowMs");
  check("same key, next window -> not limited", (await lim.isLimited("a", WIN + 1)) === false);
  await lim.record("a", WIN + 1);
  check("count restarts in the new window (1, under cap)", (await lim.isLimited("a", WIN + 1)) === false);

  console.log("\nBatch increment (record n at once)");
  await lim.record("batch", 0, 3);
  check("recording n=3 reaches the cap in one call", (await lim.isLimited("batch", 0)) === true);

  console.log("\nTwo instances sharing the store enforce ONE budget (multi-machine)");
  const inst1 = createSharedRateLimiter({ prefix: "shared", windowMs: WIN, max: 3, dbClient: db });
  const inst2 = createSharedRateLimiter({ prefix: "shared", windowMs: WIN, max: 3, dbClient: db });
  await inst1.record("phone", 0); await inst1.record("phone", 0); await inst1.record("phone", 0);
  check("instance 2 sees instance 1's writes -> limited", (await inst2.isLimited("phone", 0)) === true);

  console.log("\nFail-open (farmer paths) vs fail-closed (writes) when the store is down");
  const openLim = createSharedRateLimiter({ prefix: "o", max: 3, failOpen: true, dbClient: brokenDb });
  const closedLim = createSharedRateLimiter({ prefix: "c", max: 3, failOpen: false, dbClient: brokenDb });
  check("store down + failOpen -> NOT limited (never block a verdict/emergency)", (await openLim.isLimited("x")) === false);
  check("store down + failClosed -> limited (deny writes conservatively)", (await closedLim.isLimited("x")) === true);
  // record must never throw even when the store is down.
  let threw = false;
  try { await closedLim.record("x"); await openLim.record("x"); } catch { threw = true; }
  check("record swallows store errors (never throws into a handler)", threw === false);

  console.log("\nTTL cleanup drops expired counters");
  await db.execute("DELETE FROM rate_limits");
  await db.execute({ sql: "INSERT INTO rate_limits(bucket, window_start, count) VALUES ('old', ?, 5)", args: [0] });
  await db.execute({ sql: "INSERT INTO rate_limits(bucket, window_start, count) VALUES ('new', ?, 5)", args: [Date.now()] });
  await cleanupRateLimits(db, 3600_000, Date.now());
  const rows = (await db.execute("SELECT bucket FROM rate_limits")).rows.map((r) => r.bucket);
  check("expired counter swept", !rows.includes("old"));
  check("current counter kept", rows.includes("new"));

  await db.execute("DELETE FROM rate_limits");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
