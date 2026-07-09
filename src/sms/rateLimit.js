import { config } from "../config.js";

// In-memory sliding-window rate limiter, per phone number. Outbound SMS costs
// real money, so non-emergency inbound is capped. Emergency (HELP / route) must
// NEVER be limited — a person may be dying — so the handler simply doesn't call
// this for those.
//
// NOTE: in-memory = per-process. Behind multiple instances, move this to a
// shared store (Redis/Turso). Fine for M5 / single instance. See DECISIONS.md.
export function createRateLimiter({
  windowMs = 3600_000,
  max = config.smsRateLimitPerHour,
} = {}) {
  const hits = new Map(); // phone -> number[] (timestamps)

  function prune(phone, now) {
    const arr = (hits.get(phone) || []).filter((t) => t > now - windowMs);
    if (arr.length) hits.set(phone, arr);
    else hits.delete(phone);
    return arr;
  }

  return {
    isLimited(phone, now = Date.now()) {
      return prune(phone, now).length >= max;
    },
    record(phone, now = Date.now()) {
      const arr = prune(phone, now);
      arr.push(now);
      hits.set(phone, arr);
    },
    reset() {
      hits.clear();
    },
  };
}

// Shared default instance for the live webhook.
export const rateLimiter = createRateLimiter();
