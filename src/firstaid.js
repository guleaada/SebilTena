import { db } from "./db.js";
import { config } from "./config.js";
import { t, normalizeLang } from "./localize.js";

// ---------------------------------------------------------------------------
// FIRST-AID RETRIEVAL — RETRIEVAL ONLY. NO LLM. EVER. (Section B of M4)
//
// Every first-aid string comes straight from the `pesticides.first_aid` DB
// column. The language model is NEVER in this path — an emergency is exactly
// where a hallucinated instruction could kill someone. If an ingredient/route
// has no record we return the fixed, human-reviewed UNIVERSAL fallback below;
// we never improvise. See SAFETY.md.
// ---------------------------------------------------------------------------

// UI exposure route -> first_aid JSON key stored in the DB.
export const ROUTE_TO_KEY = {
  skin: "skin",
  eyes: "eyes",
  swallowed: "ingestion",
  breathed: "inhalation",
};

// Fixed, human-reviewed generic first-aid used when no product is identified or
// the ingredient/route has no specific record. NOT generated — a constant.
export const UNIVERSAL = {
  skin: "Take off contaminated clothes. Wash the skin with plenty of soap and clean water for at least 15 minutes. Get medical help.",
  eyes: "Rinse the eye with clean running water for at least 15 minutes, keeping the eye open. Get medical help.",
  swallowed: "Do not make the person vomit. Rinse the mouth. Do not give anything to drink unless a health worker tells you to. Get medical help immediately and bring the product container.",
  breathed: "Move the person to fresh air at once. Loosen tight clothing. If breathing is difficult, get medical help immediately.",
};

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

// Split a first-aid string into display steps (one sentence each).
export function toSteps(text) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GET /api/first-aid — first-aid for an active ingredient + exposure route.
 * Text is the DB `first_aid` value only; steps are just that text split into
 * sentences for one-at-a-time display. Unknown -> found:false (caller shows the
 * universal fallback).
 */
export async function getFirstAid(activeIngredient, route, lang = "en") {
  const language = normalizeLang(lang);
  const key = ROUTE_TO_KEY[String(route || "").toLowerCase()];
  const ing = String(activeIngredient || "").trim();

  if (!key || !ing) {
    return { found: false, route, activeIngredient: ing || null, lang: language };
  }

  const res = await db.execute({
    sql: "SELECT product_name, active_ingredient, first_aid FROM pesticides WHERE active_ingredient = ? COLLATE NOCASE LIMIT 1",
    args: [ing],
  });
  if (res.rows.length === 0) {
    return { found: false, route, activeIngredient: ing, lang: language };
  }

  const row = res.rows[0];
  const firstAid = safeParse(row.first_aid, {});
  const text = firstAid[key];
  if (!text) {
    return { found: false, route, activeIngredient: ing, lang: language };
  }

  return {
    found: true,
    source: "db_first_aid", // provenance: DB column, never generated
    activeIngredient: row.active_ingredient,
    product_name: row.product_name,
    route,
    routeKey: key,
    text,
    steps: toSteps(text),
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}

/**
 * GET /api/emergency-bundle — compact JSON cached client-side so the whole
 * emergency path works offline: every seeded ingredient's first_aid, the
 * universal fallback, agent contacts, and the poison-centre number.
 */
export async function getEmergencyBundle(lang = "en") {
  const language = normalizeLang(lang);

  const pRes = await db.execute("SELECT active_ingredient, product_name, first_aid FROM pesticides");
  const firstAidByIngredient = {};
  for (const row of pRes.rows) {
    if (firstAidByIngredient[row.active_ingredient]) continue; // keep first
    const fa = safeParse(row.first_aid, {});
    firstAidByIngredient[row.active_ingredient] = {
      product_name: row.product_name,
      skin: fa.skin || null,
      eyes: fa.eyes || null,
      ingestion: fa.ingestion || null,
      inhalation: fa.inhalation || null,
    };
  }

  const aRes = await db.execute("SELECT name, phone, region FROM extension_agents");

  return {
    generated_at: new Date().toISOString(),
    source: "db_first_aid",
    routes: ["skin", "eyes", "swallowed", "breathed"],
    route_to_key: ROUTE_TO_KEY,
    first_aid: firstAidByIngredient,
    universal: UNIVERSAL,
    agents: aRes.rows.map((r) => ({ name: r.name, phone: r.phone, region: r.region })),
    poison_centre: config.poisonCentre,
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}
