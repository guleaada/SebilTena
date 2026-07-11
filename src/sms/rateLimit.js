import { config } from "../config.js";
import { createSharedRateLimiter } from "../rateStore.js";

// In-memory sliding-window rate limiter, per phone number. Kept for the offline
// tests (which inject their own limiter). The LIVE default (`rateLimiter` below)
// is the shared-store limiter so the SMS cost-guard holds across Fly machines.
//
// Emergency (HELP / route) is NEVER limited — a person may be dying — so the
// handler simply doesn't call the limiter for those.
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

// Live default: SHARED-STORE limiter (holds across Fly machines). Fails OPEN —
// the SMS non-emergency cost guard is farmer-facing, so if the store is
// unreachable we never block a reply (a verdict/emergency must get through).
export const rateLimiter = createSharedRateLimiter({
  prefix: "sms",
  max: config.smsRateLimitPerHour,
  failOpen: true,
});
