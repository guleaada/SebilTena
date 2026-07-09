import "dotenv/config";

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
