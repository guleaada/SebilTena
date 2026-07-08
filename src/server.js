import express from "express";
import "dotenv/config";
import { db, dbMode, initSchema } from "./db.js";
import { verifyNumber } from "./verify.js";

const app = express();
app.use(express.json({ limit: "12mb" })); // headroom for base64 images (M2)

// Health / diagnostics.
app.get("/api/health", async (_req, res) => {
  try {
    const r = await db.execute("SELECT COUNT(*) AS n FROM pesticides");
    res.json({
      ok: true,
      db: dbMode,
      pesticides: Number(r.rows[0].n),
      milestone: "M1",
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
