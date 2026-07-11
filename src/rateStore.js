import { db as defaultDb } from "./db.js";

// ---------------------------------------------------------------------------
// SHARED-STORE RATE LIMITER (M8 Part C). The M5/M7.5 limiters were in-memory
// (per-process), so behind >1 Fly machine they under-enforce. This backs the
// counters with the same libSQL DB the app already uses (Turso in prod, local
// SQLite in dev) — no new infra — so limits hold across instances.
//
// Same shape as the in-memory limiter (isLimited/record) but async, so call
// sites just add `await`; an injected in-memory limiter (returning a plain
// boolean) still works under `await`, which keeps the tests unchanged.
//
// Fixed-window counters, atomic per hit via an UPSERT with a CASE that resets an
// expired window in one statement. `failOpen` decides behaviour when the store
// is unreachable: farmer-facing paths fail OPEN (never block a verdict or
// emergency), the write/sync surface fails CLOSED (deny conservatively).
// ---------------------------------------------------------------------------

const HOUR_MS = 3600_000;

export function createSharedRateLimiter({ prefix, windowMs = HOUR_MS, max, failOpen = false, dbClient = defaultDb }) {
  const bkt = (key) => `${prefix}:${key}`;

  async function currentCount(bucket, now) {
    const row = (await dbClient.execute({
      sql: "SELECT window_start, count FROM rate_limits WHERE bucket = ?",
      args: [bucket],
    })).rows[0];
    if (!row) return 0;
    if (now - Number(row.window_start) >= windowMs) return 0; // window expired -> effectively 0
    return Number(row.count);
  }

  return {
    failOpen,
    async isLimited(key, now = Date.now()) {
      try {
        return (await currentCount(bkt(key), now)) >= max;
      } catch (e) {
        console.warn(`[ratelimit:${prefix}] store error on isLimited -> ${failOpen ? "fail-open (allow)" : "fail-closed (deny)"}: ${e?.message || e}`);
        return !failOpen; // failOpen -> not limited (allow); failClosed -> limited (deny)
      }
    },
    // Increment by `n` (a sync batch records n scans at once). Atomic; resets an
    // expired window in the same statement.
    async record(key, now = Date.now(), n = 1) {
      const bucket = bkt(key);
      try {
        await dbClient.execute({
          sql: `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?)
                ON CONFLICT(bucket) DO UPDATE SET
                  count = CASE WHEN (? - rate_limits.window_start) >= ? THEN ? ELSE rate_limits.count + ? END,
                  window_start = CASE WHEN (? - rate_limits.window_start) >= ? THEN ? ELSE rate_limits.window_start END`,
          args: [bucket, now, n,  now, windowMs, n, n,  now, windowMs, now],
        });
      } catch (e) {
        // Best-effort: a failed write must never throw into a request handler.
        console.warn(`[ratelimit:${prefix}] store error on record (best-effort): ${e?.message || e}`);
      }
    },
  };
}

// Periodic TTL cleanup — drop counters whose window has fully expired.
export async function cleanupRateLimits(dbClient = defaultDb, olderThanMs = HOUR_MS, now = Date.now()) {
  try {
    await dbClient.execute({ sql: "DELETE FROM rate_limits WHERE window_start < ?", args: [now - olderThanMs] });
  } catch (e) {
    console.warn("[ratelimit] cleanup failed:", e?.message || e);
  }
}
