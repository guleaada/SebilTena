import { db } from "./db.js";
import { t, normalizeLang } from "./localize.js";

// ---------------------------------------------------------------------------
// DOSAGE RETRIEVAL — RETRIEVAL ONLY (Section 6: GET /api/dosage).
//
// Returns the stored dose record for a (pesticide, crop) pair, straight from
// the `dosages` table. If the crop has no row, we say so and route to the
// extension agent — we NEVER compute or interpolate a dose. See SAFETY.md.
// ---------------------------------------------------------------------------

export async function getDosage(pesticideId, crop, lang = "en") {
  const language = normalizeLang(lang);
  const id = Number(pesticideId);
  const cropKey = String(crop || "").trim();

  if (!Number.isFinite(id) || !cropKey) {
    return { covered: false, crop: cropKey || null, message: t(language, "msg.crop_not_covered"), lang: language };
  }

  const res = await db.execute({
    sql: `SELECT crop, dose_per_unit, application_notes, pre_harvest_interval_days
          FROM dosages WHERE pesticide_id = ? AND crop = ? COLLATE NOCASE`,
    args: [id, cropKey],
  });

  if (res.rows.length === 0) {
    // Crop not covered — do not invent a dose.
    return {
      covered: false,
      pesticideId: id,
      crop: cropKey,
      message: t(language, "msg.crop_not_covered"),
      disclaimer: t(language, "disclaimer.official"),
      lang: language,
    };
  }

  const r = res.rows[0];
  return {
    covered: true,
    pesticideId: id,
    crop: r.crop,
    dose_per_unit: r.dose_per_unit,
    application_notes: r.application_notes,
    pre_harvest_interval_days: r.pre_harvest_interval_days,
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}
