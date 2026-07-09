// ---------------------------------------------------------------------------
// FIRST-AID CONTROLLED VOCABULARY — the single source of truth.
//
// The DB `first_aid` column may ONLY contain these `aid_*` step codes, keyed by
// route of exposure. seed.js rejects anything else. This is a hard part of the
// retriever boundary: the database emits a CONTROLLED VOCABULARY, never free
// prose, so nothing can drift into ungoverned first-aid text. Every code here
// maps 1:1 to a recorded clip + localized string, so product first-aid is
// automatically voiced, localized and offline in all six languages.
//
// Mirrors docs/RECORDING_SCRIPT.md §3. Add a code here AND to the recording
// script (so it gets recorded) AND to the aid.* locale strings.
// ---------------------------------------------------------------------------

export const AID_CODES = [
  "aid_move_air",
  "aid_remove_clothes",
  "aid_rinse_skin",
  "aid_rinse_eyes",
  "aid_do_not_vomit",
  "aid_no_food_drink",
  "aid_keep_container",
  "aid_seek_help",
  "aid_if_unconscious",
];
export const AID_CODE_SET = new Set(AID_CODES);

// Exposure routes (aligned with the UI). Replaces the old skin/eyes/ingestion/
// inhalation storage keys — the DB now uses these directly.
export const ROUTES = ["skin", "eyes", "swallowed", "breathed"];
export const ROUTE_SET = new Set(ROUTES);

// Fixed, reviewed generic first-aid used when no product is identified, or a
// product has no steps for a route. Route -> ordered step codes. A CONSTANT,
// never generated. Subject to the same toxicologist sign-off (see SAFETY.md).
export const UNIVERSAL_STEPS = {
  skin: ["aid_remove_clothes", "aid_rinse_skin", "aid_no_food_drink", "aid_keep_container", "aid_seek_help"],
  eyes: ["aid_rinse_eyes", "aid_keep_container", "aid_seek_help"],
  swallowed: ["aid_do_not_vomit", "aid_no_food_drink", "aid_keep_container", "aid_seek_help", "aid_if_unconscious"],
  breathed: ["aid_move_air", "aid_seek_help", "aid_if_unconscious"],
};

/**
 * Validate a first_aid object ({ route: [aid_code, ...] }).
 * @returns {string[]} human-readable errors (empty = valid).
 */
export function validateFirstAid(firstAid, label = "first_aid") {
  const errors = [];
  if (firstAid == null || typeof firstAid !== "object" || Array.isArray(firstAid)) {
    return [`${label}: must be an object of { route: [aid_code, ...] }`];
  }
  for (const [route, codes] of Object.entries(firstAid)) {
    if (!ROUTE_SET.has(route)) {
      errors.push(`${label}: invalid route "${route}" (allowed: ${ROUTES.join(", ")})`);
    }
    if (!Array.isArray(codes)) {
      errors.push(`${label}: route "${route}" must be an array of aid codes`);
      continue;
    }
    for (const code of codes) {
      if (!AID_CODE_SET.has(code)) {
        errors.push(`${label}: unknown aid code "${code}" in route "${route}" (not in vocabulary)`);
      }
    }
  }
  return errors;
}

// Resolve steps for a route: product codes if present, else universal fallback.
// Never returns blank for a known route.
export function stepsForRoute(firstAid, route) {
  const own = firstAid && Array.isArray(firstAid[route]) ? firstAid[route] : null;
  if (own && own.length) return { codes: own, source: "product" };
  return { codes: UNIVERSAL_STEPS[route] || [], source: "universal" };
}
