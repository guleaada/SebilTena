import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { db, dbMode, initSchema } from "./db.js";
import { verifyNumber } from "./verify.js";
import { runScan, resolveConfirm } from "./scan.js";
import { getDosage } from "./dosage.js";
import { getFirstAid, getEmergencyBundle } from "./firstaid.js";
import { config } from "./config.js";
import { handleInbound } from "./sms/handler.js";
import { logEvent } from "./events.js";
import { getRegistryBundle } from "./registry.js";
import { syncScans } from "./sync.js";
import { districtAggregates, nationalSummary, districtsCsv } from "./surveillance.js";
import { issueDeviceToken, verifyDeviceToken } from "./deviceToken.js";
import { createSharedRateLimiter, cleanupRateLimits } from "./rateStore.js";
import { runPreflight } from "./preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "12mb" })); // headroom for base64 images (M2)
app.use(express.urlencoded({ extended: false })); // Africa's Talking posts form-encoded

// Staging posture (M8 Part D): this is a demonstration, not a farmer-facing
// launch — no crawler may index or cache ANY part of it. Whole-app noindex +
// a disallow-all robots.txt (the surveillance routes additionally set no-store).
app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

// --- Static: PWA shell + locale JSON (reused by the frontend and SW) --------
app.use("/locales", express.static(path.join(ROOT, "locales")));
app.use(express.static(path.join(ROOT, "public")));

// Health / diagnostics.
app.get("/api/health", async (_req, res) => {
  try {
    const r = await db.execute("SELECT COUNT(*) AS n FROM pesticides");
    res.json({
      ok: true,
      db: dbMode,
      pesticides: Number(r.rows[0].n),
      milestone: "M8",
      staging: config.staging,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /api/app-config — public, no secrets. Drives the demonstration banner and
// tells the client whether SMS is enabled. Never returns tokens or credentials.
app.get("/api/app-config", (_req, res) => {
  res.json({
    staging: config.staging,
    smsEnabled: Boolean(process.env.AT_API_KEY && process.env.AT_USERNAME),
  });
});

// POST /api/verify-number { registrationNo, lang } -> status + safety.
// Shared retrieval path used later by the SMS webhook and offline mode.
app.post("/api/verify-number", async (req, res) => {
  try {
    const { registrationNo, lang } = req.body || {};
    const result = await verifyNumber(registrationNo, lang || "en");
    res.json(result);
  } catch (err) {
    console.error("verify-number error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// Coordinates from the wire must be finite numbers in range, else null —
// `scans` feeds the surveillance grid, and SQLite's flexible typing would
// happily store client garbage in a REAL column.
const cleanCoord = (v, absMax) =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= absMax ? v : null;

// POST /api/scan { imageBase64, lang, lat?, lon? } -> runs the scan pipeline
// (Section 3). Reuses verify.js for the VERIFIED payload; logs a geotagged row.
app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64, lang, lat, lon } = req.body || {};
    const result = await runScan({ imageBase64, lang: lang || "en", lat: cleanCoord(lat, 90), lon: cleanCoord(lon, 180) });
    res.json(result);
  } catch (err) {
    console.error("scan error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// POST /api/scan/confirm { scanId, confirm, registrationNo, lang } — resolve a
// Tier-2 CONFIRM. YES -> verify.js verdict (returns the full record); NO ->
// REJECTED_BY_USER. Updates the originating scan row so it stops being pending.
app.post("/api/scan/confirm", async (req, res) => {
  try {
    const { scanId, confirm, registrationNo, lang } = req.body || {};
    const result = await resolveConfirm({ scanId, confirm: Boolean(confirm), registrationNo, lang: lang || "en" });
    res.json(result);
  } catch (err) {
    console.error("scan confirm error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/dosage?pesticideId=&crop=&lang= -> stored dose record (retrieval only).
app.get("/api/dosage", async (req, res) => {
  try {
    const { pesticideId, crop, lang } = req.query;
    const result = await getDosage(pesticideId, crop, lang || "en");
    res.json(result);
  } catch (err) {
    console.error("dosage error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/first-aid?activeIngredient=&route=&lang= -> first-aid from the DB
// first_aid column ONLY (no LLM — see SAFETY.md).
app.get("/api/first-aid", async (req, res) => {
  try {
    const { activeIngredient, route, lang } = req.query;
    res.json(await getFirstAid(activeIngredient, route, lang || "en"));
  } catch (err) {
    console.error("first-aid error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/emergency-bundle?lang= -> compact offline bundle (all first_aid
// records + universal fallback + agents + poison centre). Cached client-side.
app.get("/api/emergency-bundle", async (req, res) => {
  try {
    res.json(await getEmergencyBundle(req.query.lang || "en"));
  } catch (err) {
    console.error("emergency-bundle error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// --- Write-side anti-abuse (M7.5 B; SHARED STORE in M8 C so limits hold across
// machines). These guard ONLY the write/register surface and fail CLOSED (deny)
// if the store is unreachable — farmer verdict + emergency paths are never
// throttled at all.
const deviceRegLimiter = createSharedRateLimiter({ prefix: "devreg", max: config.deviceRegPerHourPerIp, failOpen: false });
const syncIpLimiter = createSharedRateLimiter({ prefix: "syncip", max: config.syncCallsPerHourPerIp, failOpen: false });
const syncTokenLimiter = createSharedRateLimiter({ prefix: "synctok", max: config.syncScansPerHourPerToken, failOpen: false });
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "?";

// POST /api/register-device — issue an opaque, PII-free write token (M7.5 B).
// Not authentication of a person: it only proves the writer went through the app
// once, raising the cost of scripted flooding. Rate-limited per IP.
app.post("/api/register-device", async (req, res) => {
  const ip = clientIp(req);
  if (await deviceRegLimiter.isLimited(ip)) return res.status(429).json({ ok: false, error: "rate_limited" });
  await deviceRegLimiter.record(ip);
  const { token, expMs } = issueDeviceToken();
  // Record issuance only — no token value, no IP-to-token link, no PII.
  logEvent({ type: "device_registered", channel: "app", payload: {} }).catch(() => {});
  res.json({ ok: true, token, expires_at: new Date(expMs).toISOString() });
});

// POST /api/scans/sync — flush queued offline scans (M6 Part C). Requires a
// valid app-issued write token (M7.5 B): absent/expired -> 401. Rate-limited per
// token and per IP; oversized batches are rejected, not truncated. Idempotent by
// client UUID; returns upgrades (offline verdict -> authoritative online verdict).
// The token is NEVER passed to syncScans or stored on a row — anonymity intact.
app.post("/api/scans/sync", async (req, res) => {
  try {
    const token = req.get("x-device-token") || (req.body && req.body.deviceToken) || "";
    if (!verifyDeviceToken(token)) return res.status(401).json({ ok: false, error: "device_token_required" });

    const ip = clientIp(req);
    if ((await syncIpLimiter.isLimited(ip)) || (await syncTokenLimiter.isLimited(token))) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const { scans } = req.body || {};
    const batch = Array.isArray(scans) ? scans : [];
    if (batch.length > config.syncMaxBatch) {
      return res.status(413).json({ ok: false, error: "batch_too_large", max: config.syncMaxBatch });
    }
    await syncIpLimiter.record(ip);
    await syncTokenLimiter.record(token, Date.now(), batch.length); // budget in SCANS

    const result = await syncScans(scans);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("scans sync error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/registry-bundle — compact registry snapshot for offline caching (M6).
app.get("/api/registry-bundle", async (_req, res) => {
  try {
    res.json(await getRegistryBundle());
  } catch (err) {
    console.error("registry-bundle error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// POST /api/client-event — client-side telemetry/anomalies (e.g. a sticky-ban
// override during an offline merge). Logged to `events`, never `scans`.
app.post("/api/client-event", async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ ok: false });
    await logEvent({ type: String(type).slice(0, 40), channel: "app", payload });
    res.json({ ok: true });
  } catch (err) {
    console.error("client-event error:", err);
    res.status(500).json({ ok: false });
  }
});

// POST /api/lang-fallback — a farmer picked an incomplete language. Logged to
// `events` (NOT `scans`), so we can see which languages are actually wanted
// without polluting the safety-audit / surveillance data.
app.post("/api/lang-fallback", async (req, res) => {
  try {
    const { requested, chosen, channel } = req.body || {};
    const lang = String(requested || "").slice(0, 8);
    if (!lang) return res.status(400).json({ ok: false });
    await logEvent({
      type: "lang_fallback",
      channel: channel === "sms" ? "sms" : "app",
      payload: { requested: lang, chosen: chosen ? String(chosen).slice(0, 8) : null },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("lang-fallback log error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// SURVEILLANCE (M7) — regulator-only, aggregated, gated. There is NO
// unauthenticated path to this data. Raw row-level coordinates never leave the
// server (the aggregator returns district/grid-centroid aggregates only).
// ---------------------------------------------------------------------------

// Constant-time secret comparison (hash both sides so lengths always match) —
// a plain === leaks match-prefix length through response timing.
function safeEqual(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Surveillance data must never be crawled, cached by an intermediary, or
// indexed. Applied to every surveillance route + the admin map (M7.5 Part A).
function setNoIndexNoStore(res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Bearer-token gate. Token from `Authorization: Bearer`, `x-admin-token`, or
// `?token=`. Empty config token => LOCKED (every request 401). Every access is
// audited to `events`. There is NO env var, flag, or config that disables this
// gate — surveillance has no unauthenticated path, by construction (M7.5 A).
function requireAdmin(req, res, next) {
  setNoIndexNoStore(res);
  const auth = req.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || req.get("x-admin-token") || req.query.token || "";
  const ok = Boolean(config.adminToken) && safeEqual(provided, config.adminToken);
  // Audit the attempt (never log the token itself).
  logEvent({
    type: ok ? "surveillance_access" : "surveillance_denied",
    channel: "admin",
    payload: { path: req.path, from: req.query.from || null, to: req.query.to || null, ip: req.ip },
  }).catch(() => {});
  if (!ok) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// GET /api/surveillance/districts?from=&to= — district-level aggregates (gated).
app.get("/api/surveillance/districts", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json({ ok: true, ...(await districtAggregates({ from, to })) });
  } catch (err) {
    console.error("surveillance districts error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/surveillance/summary?from=&to= — national roll-up (gated).
app.get("/api/surveillance/summary", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json({ ok: true, ...(await nationalSummary({ from, to })) });
  } catch (err) {
    console.error("surveillance summary error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/surveillance/export?from=&to= — CSV of the aggregates (gated + audited
// via requireAdmin). Carries the permanent caption as header rows.
app.get("/api/surveillance/export", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const csv = districtsCsv(await districtAggregates({ from, to }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="surveillance-districts.csv"');
    res.send(csv);
  } catch (err) {
    console.error("surveillance export error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /admin/map — the regulator dashboard shell. It is a DATALESS login form:
// it embeds no surveillance data and prompts for the token, which it keeps in
// sessionStorage and sends to the gated APIs above. A browser can't attach a
// bearer header to a navigation, so the shell itself is served unauthenticated,
// but it exposes nothing — every figure requires the gate. noindex + no-store
// so it is never crawled or cached (M7.5 Part A).
app.get("/admin/map", (_req, res) => {
  setNoIndexNoStore(res);
  res.sendFile(path.join(ROOT, "admin", "map.html"));
});

// POST /api/sms/webhook — Africa's Talking inbound SMS. Guarded by a shared
// secret when configured; parses { from, text, to, linkId, date }; replies via
// verify.js / dosage.js / firstaid.js (M5). Never trusts unauthenticated posts.
app.post("/api/sms/webhook", async (req, res) => {
  if (config.smsWebhookSecret) {
    const provided = req.get("x-webhook-secret") || req.query.secret;
    if (!safeEqual(provided, config.smsWebhookSecret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  } else {
    console.warn("[sms] AT_WEBHOOK_SECRET unset — webhook is UNGUARDED (dev only).");
  }
  try {
    const { from, text, to, linkId, date } = req.body || {};
    if (!from) return res.status(400).json({ ok: false, error: "missing_from" });
    const result = await handleInbound({ from, text, to, linkId, date });
    res.json({ ok: true, status: result.status, replies: result.replies.length });
  } catch (err) {
    console.error("sms webhook error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

const PORT = process.env.PORT || 3000;

// Startup: ensure schema, then run the centralized preflight (SAFETY.md release
// gate + required-secret checks). Any fatal condition on a hardened deployment
// (NODE_ENV=production or STAGING=true) => exit non-zero. Fail closed.
initSchema()
  .then(async () => {
    const pf = await runPreflight();
    if (!pf.ok) process.exit(1);
    app.listen(PORT, () => {
      console.log(`MedaGuard listening on http://localhost:${PORT}  (db: ${dbMode})`);
    });
    // Sweep expired rate-limit counters periodically (shared-store TTL cleanup).
    cleanupRateLimits();
    setInterval(() => cleanupRateLimits(), 15 * 60 * 1000).unref();
  })
  .catch((err) => {
    console.error("Failed to initialise schema:", err);
    process.exit(1);
  });
