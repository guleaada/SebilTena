// ---------------------------------------------------------------------------
// SAFE ACTION PLAN — CONTROLLED VOCABULARY (M13). The single source of truth for
// every code the advisor may emit. Mirrors the aidCodes.js pattern: the DB stores
// CODES, never prose; the client resolves each code to a reviewed, localized
// string. seed.js rejects anything outside this vocabulary, so no agronomic
// advice can drift into ungoverned free text. See SAFETY.md.
//
// THE BOUNDARY (SAFETY.md — "the AI is a RETRIEVER, not an ADVISER"):
//   * The advisor NEVER diagnoses. `symptom_causes` deliberately maps ONE symptom
//     to MANY possible causes — including ABIOTIC ones (nutrient/water/chemical
//     damage) that a pesticide cannot fix. It presents possibilities + how to tell
//     them apart; the farmer (or an extension agent) decides.
//   * Non-chemical IPM comes FIRST, always.
//   * The pest -> product layer is REVIEW-GATED and ships DARK: it stays hidden
//     until an agronomist signs the mappings through /admin/review. Nothing here
//     invents a dose, a PHI, a PPE list or a risk score — those come from the
//     registry rows the app already retrieves.
// ---------------------------------------------------------------------------

// What a farmer can report. Kept small, iconic and voice-friendly.
export const SYMPTOMS = [
  "leaves_yellow",
  "holes_in_leaves",
  "spots_on_leaves",
  "wilting",
  "insects_visible",
  "stunted_growth",
];
export const SYMPTOM_SET = new Set(SYMPTOMS);

// DIRECT-OBSERVATION symptoms: the farmer has seen the organism itself, so there
// is no honest abiotic ("not a pest") cause to offer — and inventing one to
// satisfy a rule would be dishonest. These are EXEMPT from the abiotic
// requirement that seed.js enforces on every other symptom.
//
// NOTE for the agronomist review: these symptoms still need their own honesty
// angle — seeing an insect does not make it the cause, and many insects are
// beneficial (spraying can kill the ladybirds eating your aphids). That belongs
// in the IPM content for these causes ("protect_natural_enemies" leads), not in
// a fake abiotic row.
export const DIRECT_OBSERVATION_SYMPTOMS = ["insects_visible"];
export const DIRECT_OBSERVATION_SET = new Set(DIRECT_OBSERVATION_SYMPTOMS);

// A cause is a pest, a disease, or ABIOTIC (not a living pest at all — spraying
// will not help). The abiotic kind exists precisely so the plan can say so.
export const CAUSE_KINDS = ["pest", "disease", "abiotic"];
export const CAUSE_KIND_SET = new Set(CAUSE_KINDS);

export const LIKELIHOODS = ["common", "possible", "rare"];
export const LIKELIHOOD_SET = new Set(LIKELIHOODS);

// IPM categories, in the order the plan presents them (least invasive first).
export const IPM_CATEGORIES = ["cultural", "biological", "mechanical"];
export const IPM_CATEGORY_SET = new Set(IPM_CATEGORIES);

// Cause codes -> localized names (`cause.*`). Abiotic causes are first-class.
export const CAUSE_CODES = [
  // diseases
  "late_blight", "early_blight", "leaf_rust", "powdery_mildew",
  // pests
  "aphids", "stalk_borer", "cutworm", "whitefly", "red_spider_mite",
  // ABIOTIC — a pesticide cannot fix any of these
  "nitrogen_deficiency", "water_stress", "waterlogging", "herbicide_damage", "natural_ageing",
];
export const CAUSE_CODE_SET = new Set(CAUSE_CODES);

// "How to tell it apart" hints (`distinguish.*`) — observational, never a verdict.
export const DISTINGUISH_CODES = [
  "check_lower_leaves_first", "check_whole_field_pattern", "look_under_leaves",
  "check_soil_moisture", "look_for_insects", "check_recent_spraying", "check_leaf_edges",
];
export const DISTINGUISH_CODE_SET = new Set(DISTINGUISH_CODES);

// Non-chemical practices (`ipm.*`). These are the FIRST thing the plan shows.
export const PRACTICE_CODES = [
  // cultural
  "rotate_crops", "remove_infected_plants", "resistant_variety", "proper_spacing",
  "clean_tools", "timely_planting", "balanced_fertilizer", "improve_drainage", "water_correctly",
  // biological
  "protect_natural_enemies", "neem_extract",
  // mechanical
  "handpick_pests", "sticky_traps", "physical_barrier", "weed_control",
];
export const PRACTICE_CODE_SET = new Set(PRACTICE_CODES);

/**
 * Validate one seed cause row. Returns human-readable errors (empty = valid).
 * Fails LOUDLY at seed time — a bad code must never reach the DB, where it would
 * surface to a farmer as a missing/incorrect string.
 */
export function validateCause(row, label = "symptom_cause") {
  const e = [];
  if (!SYMPTOM_SET.has(row?.symptom_key)) e.push(`${label}: unknown symptom "${row?.symptom_key}"`);
  if (!CAUSE_CODE_SET.has(row?.cause_key)) e.push(`${label}: unknown cause "${row?.cause_key}"`);
  if (!CAUSE_KIND_SET.has(row?.kind)) e.push(`${label}: invalid kind "${row?.kind}" (${CAUSE_KINDS.join("/")})`);
  if (!LIKELIHOOD_SET.has(row?.likelihood)) e.push(`${label}: invalid likelihood "${row?.likelihood}"`);
  if (row?.distinguish_key && !DISTINGUISH_CODE_SET.has(row.distinguish_key)) {
    e.push(`${label}: unknown distinguish code "${row.distinguish_key}"`);
  }
  return e;
}

/** Validate one seed IPM practice row. */
export function validatePractice(row, label = "ipm_practice") {
  const e = [];
  if (!CAUSE_CODE_SET.has(row?.cause_key)) e.push(`${label}: unknown cause "${row?.cause_key}"`);
  if (!IPM_CATEGORY_SET.has(row?.category)) e.push(`${label}: invalid category "${row?.category}"`);
  if (!PRACTICE_CODE_SET.has(row?.practice_key)) e.push(`${label}: unknown practice "${row?.practice_key}"`);
  return e;
}

/** True when a cause cannot be treated with a pesticide (spraying will not help). */
export const isAbiotic = (kind) => kind === "abiotic";
