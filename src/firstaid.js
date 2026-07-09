import { db } from "./db.js";
import { config } from "./config.js";
import { t, normalizeLang } from "./localize.js";
import { ROUTES, UNIVERSAL_STEPS, stepsForRoute } from "./aidCodes.js";

// ---------------------------------------------------------------------------
// FIRST-AID RETRIEVAL — RETRIEVAL ONLY. NO LLM. EVER. NO PROSE ON THE WIRE.
//
// The DB `first_aid` column is a CONTROLLED VOCABULARY: { route: [aid_code] }.
// These endpoints return step CODES; the client resolves each code to localized
// text (aid.* in /locales) + a recorded audio clip. The language model is NEVER
// in this path — an emergency is exactly where a hallucinated instruction could
// kill someone. Missing route -> the fixed UNIVERSAL_STEPS fallback; never
// blank, never improvised. See SAFETY.md and src/aidCodes.js.
// ---------------------------------------------------------------------------

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

/**
 * GET /api/first-aid — step codes for an active ingredient + exposure route.
 * Returns { steps: [aid_code, ...] } from the DB, or the universal fallback for
 * a route the product does not cover. No prose crosses the wire.
 */
export async function getFirstAid(activeIngredient, route, lang = "en") {
  const language = normalizeLang(lang);
  const r = String(route || "").toLowerCase();
  const ing = String(activeIngredient || "").trim();

  if (!ROUTES.includes(r)) {
    return { found: false, error: "invalid_route", route, routes: ROUTES, lang: language };
  }

  let firstAid = null;
  let productName = null;
  let reviewed = false;
  if (ing) {
    const res = await db.execute({
      sql: "SELECT product_name, active_ingredient, first_aid, reviewed FROM pesticides WHERE active_ingredient = ? COLLATE NOCASE LIMIT 1",
      args: [ing],
    });
    if (res.rows.length) {
      firstAid = safeParse(res.rows[0].first_aid, {});
      productName = res.rows[0].product_name;
      reviewed = Number(res.rows[0].reviewed) === 1;
    }
  }

  const { codes, source } = stepsForRoute(firstAid, r);
  return {
    found: Boolean(firstAid),         // whether a product record existed
    source: firstAid ? source : "universal", // 'product' | 'universal'
    provenance: "db_controlled_vocab", // never generated, never prose
    activeIngredient: ing || null,
    product_name: productName,
    route: r,
    steps: codes,                     // CODES only — client resolves text + audio
    reviewed,
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}

/**
 * GET /api/emergency-bundle — compact JSON cached client-side so the whole
 * emergency path works offline. Per-ingredient route->code arrays, the universal
 * fallback codes, agent contacts, and the poison-centre number. No prose.
 */
export async function getEmergencyBundle(lang = "en") {
  const language = normalizeLang(lang);

  const pRes = await db.execute("SELECT active_ingredient, product_name, first_aid, reviewed FROM pesticides");
  const firstAidByIngredient = {};
  let anyUnreviewed = false;
  for (const row of pRes.rows) {
    if (firstAidByIngredient[row.active_ingredient]) continue; // keep first
    const routes = safeParse(row.first_aid, {});
    if (Number(row.reviewed) !== 1) anyUnreviewed = true;
    firstAidByIngredient[row.active_ingredient] = {
      product_name: row.product_name,
      reviewed: Number(row.reviewed) === 1,
      routes, // { route: [aid_code, ...] }
    };
  }

  const aRes = await db.execute("SELECT name, phone, region FROM extension_agents");

  return {
    generated_at: new Date().toISOString(),
    provenance: "db_controlled_vocab",
    reviewed: !anyUnreviewed,          // false if any ingredient is unreviewed
    routes: ROUTES,
    first_aid: firstAidByIngredient,
    universal: UNIVERSAL_STEPS,        // route -> [aid_code, ...]
    agents: aRes.rows.map((r) => ({ name: r.name, phone: r.phone, region: r.region })),
    poison_centre: config.poisonCentre,
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}
