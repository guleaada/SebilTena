import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { db, dbMode, initSchema } from "./db.js";
import { verifyNumber } from "./verify.js";
import { runScan } from "./scan.js";
import { getDosage } from "./dosage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "12mb" })); // headroom for base64 images (M2)

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

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MedaGuard listening on http://localhost:${PORT}  (db: ${dbMode})`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise schema:", err);
    process.exit(1);
  });
