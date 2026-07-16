import { db as defaultDb } from "./db.js";
import { t, normalizeLang } from "./localize.js";
import { SYMPTOM_SET, IPM_CATEGORIES, isAbiotic } from "./advisorCodes.js";

// ---------------------------------------------------------------------------
// SAFE ACTION PLAN (M13) — the IPM-first crop-problem advisor.
//
// THIS MODULE DOES NOT DIAGNOSE AND DOES NOT RECOMMEND A CHEMICAL.
// It stays inside the SAFETY.md boundary ("the AI is a RETRIEVER, not an
// ADVISER") by construction:
//
//   1. NO DIAGNOSIS. A symptom maps to MANY possible causes, ranked only by
//      stored `likelihood`, each with an observational "how to tell it apart"
//      code. The farmer decides; we never pick one.
//   2. NOT-A-PEST FIRST. Abiotic causes (nitrogen deficiency, water stress,
//      herbicide damage...) are surfaced up front, and when a common one exists
//      the plan carries `spraying_may_not_help: true`. "Leaves yellow" is most
//      often a fertility or water problem, and spraying poison at it costs a
//      farmer money and exposes them for nothing.
//   3. NON-CHEMICAL FIRST, ALWAYS. IPM practices are returned before any
//      chemical section is even considered.
//   4. THE CHEMICAL LAYER IS REVIEW-GATED AND SHIPS DARK. `cause_products` rows
//      only surface when CLEARED (reviewed=1 AND reviewed_by AND reviewed_at) —
//      the same definition the first-aid boot-gate uses (src/review.js). With
//      unsigned content the API returns `chemical.status:"awaiting_review"` and
//      an EMPTY option list. No agronomist sign-off, no chemical. Ever.
//   5. NOTHING IS INVENTED. Even once cleared, a mapping only POINTS AT a
//      registry row: dose/PHI/PPE/hazard come from `dosages`/`pesticides` via
//      the same retrieval the scan path uses. There is no "Green Score" — risk
//      is reported as the product's WHO hazard class, a published standard we
//      already store, not a number we made up.
//   6. UNREVIEWED CONTENT IS LABELLED. Every plan reports `content_reviewed`
//      so the UI can say plainly that this guidance is not yet approved.
// ---------------------------------------------------------------------------

// "Cleared" here means the same thing it means everywhere else in this codebase
// (src/review.js CLEARED_SQL): reviewed = 1 AND reviewed_by AND reviewed_at. It
// is spelled out per-table in the query below so each gate is readable at a
// glance — this is the most safety-critical predicate in the module.
const LIKELIHOOD_RANK = { common: 0, possible: 1, rare: 2 };

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

/** Crops we can advise on = crops the registry actually knows (cached client-side). */
export async function advisorCrops(dbClient = defaultDb) {
  const res = await dbClient.execute("SELECT DISTINCT crop FROM dosages ORDER BY crop");
  return res.rows.map((r) => r.crop).filter(Boolean);
}

/**
 * Build a Safe Action Plan for a crop + reported symptom.
 * Strict input validation: an unknown symptom is REJECTED rather than guessed at
 * (conservative failure mode — SAFETY.md). An unknown crop is allowed through as
 * `null` (crop-agnostic causes still apply) but never invented.
 *
 * @returns {Promise<object>} plan, or { ok:false, error } on invalid input.
 */
export async function safeActionPlan({ crop, symptom, lang } = {}, deps = {}) {
  const dbc = deps.db ?? defaultDb;
  const language = normalizeLang(lang);
  const symptomKey = String(symptom || "").trim();
  const cropKey = String(crop || "").trim() || null;

  // --- Input validation: fail safe, never guess -----------------------------
  if (!SYMPTOM_SET.has(symptomKey)) {
    return { ok: false, error: "unknown_symptom", lang: language };
  }

  // --- 1. Possible causes (NEVER a diagnosis) -------------------------------
  // Crop-specific rows + crop-agnostic (crop IS NULL) rows.
  const causeRes = await dbc.execute({
    sql: `SELECT cause_key, kind, likelihood, distinguish_key, reviewed, reviewed_by, reviewed_at
          FROM symptom_causes
          WHERE symptom_key = ? AND (crop IS NULL OR crop = ? COLLATE NOCASE)`,
    args: [symptomKey, cropKey],
  });

  // De-duplicate (a crop-specific row wins over the generic one) and rank by
  // stored likelihood only — we add no judgement of our own.
  const byCause = new Map();
  for (const r of causeRes.rows) {
    const prev = byCause.get(r.cause_key);
    if (!prev || LIKELIHOOD_RANK[r.likelihood] < LIKELIHOOD_RANK[prev.likelihood]) {
      byCause.set(r.cause_key, r);
    }
  }
  const causes = [...byCause.values()]
    .sort((a, b) => LIKELIHOOD_RANK[a.likelihood] - LIKELIHOOD_RANK[b.likelihood])
    .map((r) => ({
      cause_key: r.cause_key,
      kind: r.kind,
      abiotic: isAbiotic(r.kind), // true = a pesticide cannot fix this
      likelihood: r.likelihood,
      distinguish_key: r.distinguish_key || null,
    }));

  // The honesty flag: a COMMON not-a-pest cause exists for this symptom.
  const sprayingMayNotHelp = causes.some((c) => c.abiotic && c.likelihood === "common");

  // --- 2. Non-chemical IPM, ALWAYS first ------------------------------------
  const causeKeys = causes.map((c) => c.cause_key);
  let ipm = [];
  if (causeKeys.length) {
    const ph = causeKeys.map(() => "?").join(",");
    const ipmRes = await dbc.execute({
      sql: `SELECT cause_key, category, practice_key, step_order
            FROM ipm_practices
            WHERE cause_key IN (${ph}) AND (crop IS NULL OR crop = ? COLLATE NOCASE)`,
      args: [...causeKeys, cropKey],
    });
    // De-dupe identical practices across causes; order by category (least
    // invasive first), then the stored step order.
    const seen = new Set();
    ipm = ipmRes.rows
      .filter((r) => { const k = `${r.category}:${r.practice_key}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((r) => ({ category: r.category, practice_key: r.practice_key, for_cause: r.cause_key, step_order: Number(r.step_order) || 0 }))
      .sort((a, b) =>
        IPM_CATEGORIES.indexOf(a.category) - IPM_CATEGORIES.indexOf(b.category) || a.step_order - b.step_order
      );
  }

  // --- 3. The chemical layer — GATED, and dark until signed off -------------
  const chemical = await chemicalOptions({ causeKeys, cropKey, dbc });

  // --- 4. Is the advice content itself reviewed? ----------------------------
  // Report honestly rather than implying approval we don't have.
  const contentReviewed = causeRes.rows.length > 0 &&
    causeRes.rows.every((r) => Number(r.reviewed) === 1 && r.reviewed_by && r.reviewed_at);

  return {
    ok: true,
    crop: cropKey,
    symptom: symptomKey,
    // Codes only — the client resolves each to a reviewed, localized string.
    causes,
    spraying_may_not_help: sprayingMayNotHelp,
    ipm,                       // non-chemical, always first
    chemical,                  // { status, options } — empty until agronomist-signed
    content_reviewed: contentReviewed,
    disclaimer: t(language, "disclaimer.official"),
    lang: language,
  };
}

/**
 * Chemical options for the plan. Returns an EMPTY list with
 * status:"awaiting_review" unless BOTH the cause->product mapping AND the
 * product itself are cleared. Facts come from the registry, never from here.
 */
async function chemicalOptions({ causeKeys, cropKey, dbc }) {
  // Without a crop we cannot honour the registry's per-crop dosage rows, so we
  // do not offer chemicals at all (conservative).
  if (!causeKeys.length || !cropKey) return { status: "not_applicable", options: [] };

  const ph = causeKeys.map(() => "?").join(",");
  // BOTH gates must pass, in one query:
  //   (a) the cause->product MAPPING is agronomist-cleared, AND
  //   (b) the PRODUCT itself is cleared (the first-aid release gate), AND
  //   (c) the product is currently `registered` — a banned/suspended product is
  //       never offered as an option, whatever a mapping says.
  const res = await dbc.execute({
    sql: `SELECT p.id, p.registration_no, p.product_name, p.active_ingredient, p.hazard_class,
                 p.ppe_required, p.status
          FROM cause_products cp
          JOIN pesticides p ON p.id = cp.pesticide_id
          WHERE cp.cause_key IN (${ph})
            AND cp.crop = ? COLLATE NOCASE
            AND cp.reviewed = 1 AND cp.reviewed_by IS NOT NULL AND cp.reviewed_at IS NOT NULL
            AND  p.reviewed = 1 AND  p.reviewed_by IS NOT NULL AND  p.reviewed_at IS NOT NULL
            AND  p.status = 'registered'`,
    args: [...causeKeys, cropKey],
  });

  if (!res.rows.length) {
    // Nothing signed off -> the layer stays dark. This is the shipping state.
    return { status: "awaiting_review", options: [] };
  }

  // Attach the registry's own dosage row for THIS crop. If the registry has no
  // dose for the crop, we do NOT invent or interpolate one — we drop the option
  // (SAFETY.md: "Do NOT compute or interpolate a dose the DB doesn't have").
  const options = [];
  for (const r of res.rows) {
    const d = await dbc.execute({
      sql: `SELECT dose_per_unit, application_notes, pre_harvest_interval_days
            FROM dosages WHERE pesticide_id = ? AND crop = ? COLLATE NOCASE LIMIT 1`,
      args: [r.id, cropKey],
    });
    if (!d.rows.length) continue; // no registered dose for this crop -> not an option
    options.push({
      registration_no: r.registration_no,
      product_name: r.product_name,
      active_ingredient: r.active_ingredient,
      hazard_class: r.hazard_class,          // WHO standard — NOT an invented score
      ppe_required: safeParse(r.ppe_required, []),
      dose_per_unit: d.rows[0].dose_per_unit,
      application_notes: d.rows[0].application_notes,
      pre_harvest_interval_days: d.rows[0].pre_harvest_interval_days,
      source: "registry",                     // provenance: retrieved, never generated
    });
  }
  return options.length ? { status: "available", options } : { status: "awaiting_review", options: [] };
}
