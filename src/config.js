import "dotenv/config";
import crypto from "node:crypto";

// Tunables for the scan pipeline. Everything the M2 flow needs to be tuned
// against real Ethiopian label photos later lives here, env-overridable.
export const config = {
  // Tier-2 fuzzy name/active-ingredient acceptance. Start ~0.82; raise if we
  // see false CONFIRM prompts, lower if real products are missed. (Section 4)
  fuzzyThreshold: num(process.env.MATCH_FUZZY_THRESHOLD, 0.82),

  // A normalized registration string must be at least this long for a Tier-1
  // exact substring hit — guards against trivial false positives.
  regNoMinLen: num(process.env.MATCH_REGNO_MIN_LEN, 5),

  // Tesseract self-reported confidence (0–100) below which we treat the OCR as
  // unusable and lean on the anchor match / vision fallback.
  ocrMinConfidence: num(process.env.OCR_MIN_CONFIDENCE, 55),

  // Per-provider vision call timeout.
  aiTimeoutMs: num(process.env.AI_TIMEOUT_MS, 12000),

  // A provider answer is accepted only at these confidences; 'low' falls
  // through to the next provider (then to the conservative default).
  visionAcceptConfidence: ["high", "medium"],

  // Poison-centre number surfaced in the emergency flow. PLACEHOLDER — set the
  // real national poison-information line before deployment.
  poisonCentre: process.env.POISON_CENTRE_NUMBER || "+251-11-XXXXXXX",

  // --- SMS channel (M5) ---
  // Shared secret guarding /api/sms/webhook. If set, inbound posts must present
  // it (?secret= or x-webhook-secret header); if unset, dev allows (logs a warn).
  smsWebhookSecret: process.env.AT_WEBHOOK_SECRET || "",
  // Non-emergency inbound messages allowed per phone per hour (cost guard).
  smsRateLimitPerHour: num(process.env.SMS_RATE_LIMIT_PER_HOUR, 20),
  // How long a "last verified product" stays usable for CROP / emergency context.
  smsSessionTtlMin: num(process.env.SMS_SESSION_TTL_MIN, 30),
  // Max inbound characters processed (defensive cap before any handling).
  smsInboundMaxChars: num(process.env.SMS_INBOUND_MAX_CHARS, 160),

  // --- Offline (M6) ---
  // Reachability timeout: how long the client waits before deciding a request is
  // "offline" (net.js decides by OUTCOME, not the onLine flag). Mirror of the
  // TIMEOUT_MS constant in public/js/net.js.
  reachabilityTimeoutMs: num(process.env.REACHABILITY_TIMEOUT_MS, 4000),
  // A cached VERIFIED verdict downgrades to caution after this many days.
  staleAfterDays: num(process.env.STALE_AFTER_DAYS, 90),
  // Refresh the offline registry bundle when online and older than this.
  refreshAfterDays: num(process.env.REFRESH_AFTER_DAYS, 7),
  // Max queued offline scans before dropping the oldest.
  offlineQueueMax: num(process.env.OFFLINE_QUEUE_MAX, 200),

  // --- Surveillance / counterfeit map (M7) ---
  // A district shows a counterfeit SIGNAL only when it clears BOTH floors, else
  // it renders "insufficient data" (never flagged, never clean). This is the
  // single most important safeguard in M7 — one bad scan must not paint a red
  // district. See SAFETY.md.
  surveillance: {
    minDistrictScans: num(process.env.SURV_MIN_DISTRICT_SCANS, 10), // denominator floor
    minFlagCount: num(process.env.SURV_MIN_FLAG_COUNT, 3),          // flagged-count floor
    minProductCount: num(process.env.SURV_MIN_PRODUCT_COUNT, 3),    // name a product only at/above this
    windowDays: num(process.env.SURV_WINDOW_DAYS, 90),              // default date range
    gridSize: num(process.env.SURV_GRID_SIZE, 0.1),                 // ~11km coarse grid for coord snapping
    // Sample-size -> confidence label. provisional < indicativeAt <= indicative < strongAt <= strong.
    indicativeAt: num(process.env.SURV_INDICATIVE_AT, 30),
    strongAt: num(process.env.SURV_STRONG_AT, 100),
  },
  // Shared bearer token gating every /api/surveillance/* endpoint + /admin/map.
  // No token -> 401. There is NO unauthenticated path to surveillance data.
  adminToken: process.env.ADMIN_TOKEN || "",

  // --- Write-side anti-abuse (M7.5 Part B) ---
  // Opaque, PII-free, rotating write token proving the writer went through the
  // app once (NOT identity — no farmer accounts). HMAC secret: set in prod so
  // tokens survive restarts / span instances; a random per-process default keeps
  // dev working (clients just re-register, which is cheap + rate-limited).
  deviceTokenSecret: process.env.DEVICE_TOKEN_SECRET || crypto.randomBytes(32).toString("hex"),
  deviceTokenIssuedFromEnv: Boolean(process.env.DEVICE_TOKEN_SECRET),
  deviceTokenTtlDays: num(process.env.DEVICE_TOKEN_TTL_DAYS, 7),
  // Rate limits on the WRITE + REGISTER surface only. Farmer-facing verdict and
  // emergency paths are NEVER throttled. In-memory (per-process) — move to a
  // shared store behind multiple instances (same caveat as the M5 SMS limiter).
  deviceRegPerHourPerIp: num(process.env.DEVICE_REG_PER_HOUR_PER_IP, 10),
  syncScansPerHourPerToken: num(process.env.SYNC_SCANS_PER_HOUR_PER_TOKEN, 60),
  syncCallsPerHourPerIp: num(process.env.SYNC_CALLS_PER_HOUR_PER_IP, 120),
  syncMaxBatch: num(process.env.SYNC_MAX_BATCH, 200), // = offlineQueueMax; reject, don't truncate

  // Vision models per provider (all vision-capable). Overridable so exact model
  // IDs are never load-bearing — see DECISIONS.md.
  models: {
    groq: process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
    openrouter: process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.0-flash-001",
    gemini: process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash",
  },
};

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
