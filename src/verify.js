import { db } from "./db.js";
import { t, normalizeLang } from "./localize.js";

// ---------------------------------------------------------------------------
// CORE VERIFICATION — RETRIEVAL ONLY.
//
// Given a registration number, this returns a verdict + the VERIFIED safety
// record straight from the DB. No language model touches dosage, first-aid,
// PPE or PHI here. The LLM's only role (Milestone 2) is upstream: reading the
// number off a photo. Once we have a number, everything below is a lookup.
// See SAFETY.md.
// ---------------------------------------------------------------------------

const WARNING = {
  VERIFIED: "safe",
  EXPIRED: "warning",
  SUSPENDED: "danger",
  BANNED: "danger",
  UNREGISTERED: "danger",
  UNCONFIRMED: "danger",
};

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function isExpired(expiry) {
  if (!expiry) return false;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

// registered + not expired -> VERIFIED; else the appropriate flag.
function deriveStatus(row) {
  if (row.status === "banned") return "BANNED";
  if (row.status === "suspended") return "SUSPENDED";
  if (isExpired(row.expiry_date)) return "EXPIRED";
  return "VERIFIED";
}

async function getDosages(pesticideId) {
  const res = await db.execute({
    sql: `SELECT crop, dose_per_unit, application_notes, pre_harvest_interval_days
          FROM dosages WHERE pesticide_id = ? ORDER BY crop`,
    args: [pesticideId],
  });
  return res.rows.map((r) => ({
    crop: r.crop,
    dose_per_unit: r.dose_per_unit,
    application_notes: r.application_notes,
    pre_harvest_interval_days: r.pre_harvest_interval_days,
  }));
}

function productPublicFields(row) {
  return {
    id: row.id,
    registration_no: row.registration_no,
    product_name: row.product_name,
    active_ingredient: row.active_ingredient,
    formulation: row.formulation,
    registrant: row.registrant,
    registration_date: row.registration_date,
    expiry_date: row.expiry_date,
    hazard_class: row.hazard_class,
  };
}

// Conservative default: whenever we cannot positively confirm a product, the
// failure mode is "do not use / go ask a human" — never a guess.
function unconfirmed(lang, regRead) {
  return {
    status: "UNCONFIRMED",
    confidence: "low",
    warningLevel: WARNING.UNCONFIRMED,
    speak: true,
    registration_no_read: regRead || null,
    headline: t(lang, "status.UNCONFIRMED"),
    message: t(lang, "msg.conservative"),
    disclaimer: t(lang, "disclaimer.official"),
    product: null,
    safety: null,
    dosages: [],
    lang,
  };
}

/**
 * Verify a pesticide by its official registration number.
 * @param {string} registrationNo
 * @param {string} lang  one of the 6 supported languages (falls back to en)
 * @returns {Promise<object>} verdict + safety record (all fields DB-sourced)
 */
export async function verifyNumber(registrationNo, lang = "en") {
  const language = normalizeLang(lang);
  const regNo = (registrationNo || "").trim();

  if (!regNo) return unconfirmed(language, null);

  const res = await db.execute({
    sql: "SELECT * FROM pesticides WHERE registration_no = ? COLLATE NOCASE",
    args: [regNo],
  });

  // NO MATCH is itself the counterfeit / unregistered signal.
  if (res.rows.length === 0) {
    return {
      status: "UNREGISTERED",
      confidence: "high", // an exact registry lookup definitively found nothing
      warningLevel: WARNING.UNREGISTERED,
      speak: true,
      registration_no_read: regNo,
      headline: t(language, "status.UNREGISTERED"),
      message: t(language, "msg.unregistered"),
      disclaimer: t(language, "disclaimer.official"),
      product: null,
      safety: null,
      dosages: [],
      lang: language,
    };
  }

  const row = res.rows[0];
  const status = deriveStatus(row);

  const base = {
    status,
    confidence: "high",
    warningLevel: WARNING[status],
    speak: true,
    registration_no_read: regNo,
    headline: t(language, `status.${status}`),
    message: t(language, `msg.${status.toLowerCase()}`),
    disclaimer: t(language, "disclaimer.official"),
    product: productPublicFields(row),
    lang: language,
  };

  // Banned / suspended: never surface usage instructions. Loud warning only.
  if (status === "BANNED" || status === "SUSPENDED") {
    return { ...base, safety: null, dosages: [] };
  }

  const safety = {
    hazard_class: row.hazard_class,
    ppe_required: safeParse(row.ppe_required, []),
    first_aid: safeParse(row.first_aid, {}),
    approved_crops: safeParse(row.approved_crops, []),
  };

  // Expired: show what it is + warn, but do not present it as usable.
  if (status === "EXPIRED") {
    return { ...base, confidence: "high", safety, dosages: [] };
  }

  // VERIFIED: full retrieved safety record + dosages.
  return { ...base, safety, dosages: await getDosages(row.id) };
}
