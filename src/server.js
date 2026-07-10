import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { db, dbMode, initSchema } from "./db.js";
import { verifyNumber } from "./verify.js";
import { runScan } from "./scan.js";
import { getDosage } from "./dosage.js";
import { getFirstAid, getEmergencyBundle } from "./firstaid.js";
import { config } from "./config.js";
import { handleInbound } from "./sms/handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "12mb" })); // headroom for base64 images (M2)
app.use(express.urlencoded({ extended: false })); // Africa's Talking posts form-encoded

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
      milestone: "M3",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
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

// POST /api/scan { imageBase64, lang, lat?, lon? } -> runs the scan pipeline
// (Section 3). Reuses verify.js for the VERIFIED payload; logs a geotagged row.
app.post("/api/scan", async (req, res) => {
  try {
    const { imageBase64, lang, lat, lon } = req.body || {};
    const result = await runScan({ imageBase64, lang: lang || "en", lat, lon });
    res.json(result);
  } catch (err) {
    console.error("scan error:", err);
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

// POST /api/lang-fallback — log when a farmer picks an incomplete language and
// receives a fallback, so we can see which languages are actually wanted.
app.post("/api/lang-fallback", async (req, res) => {
  try {
    const { requested, channel } = req.body || {};
    const lang = String(requested || "").slice(0, 8);
    if (!lang) return res.status(400).json({ ok: false });
    await db.execute({
      sql: `INSERT INTO scans (result_status, language, channel) VALUES (?,?,?)`,
      args: ["LANG_FALLBACK", lang, channel === "sms" ? "sms" : "app"],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("lang-fallback log error:", err);
    res.status(500).json({ ok: false });
  }
});

// POST /api/sms/webhook — Africa's Talking inbound SMS. Guarded by a shared
// secret when configured; parses { from, text, to, linkId, date }; replies via
// verify.js / dosage.js / firstaid.js (M5). Never trusts unauthenticated posts.
app.post("/api/sms/webhook", async (req, res) => {
  if (config.smsWebhookSecret) {
    const provided = req.get("x-webhook-secret") || req.query.secret;
    if (provided !== config.smsWebhookSecret) {
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

// Release gate: if any seeded product's first-aid is not toxicologist-reviewed,
// print a loud, unmissable warning. This build is NOT cleared for field use.
// See SAFETY.md.
async function checkReviewGate() {
  try {
    const r = await db.execute("SELECT COUNT(*) AS n FROM pesticides WHERE reviewed = 0");
    const unreviewed = Number(r.rows[0].n);
    if (unreviewed > 0) {
      const bar = "!".repeat(64);
      console.warn(`\n${bar}`);
      console.warn(`!! MedaGuard: ${unreviewed} product(s) have UNREVIEWED first-aid data.`);
      console.warn("!! First-aid steps have NOT been signed off by a toxicologist /");
      console.warn("!! poison-control professional. This build is NOT CLEARED FOR FIELD USE.");
      console.warn("!! See SAFETY.md (First-aid content release gate).");
      console.warn(`${bar}\n`);
    }
  } catch (err) {
    console.warn("review-gate check failed:", err?.message || err);
  }
}

initSchema()
  .then(async () => {
    await checkReviewGate();
    app.listen(PORT, () => {
      console.log(`MedaGuard listening on http://localhost:${PORT}  (db: ${dbMode})`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise schema:", err);
    process.exit(1);
  });
