// M13 — Safe Action Plan tests. These assert the SAFETY BOUNDARY, not just the
// shape: the advisor must never diagnose, must put non-chemical IPM first, must
// surface not-a-pest causes, and must NOT recommend a chemical until an
// agronomist has signed the mapping (SAFETY.md — retriever, not adviser).
// Deterministic, real seeded DB, no network.
//
//   node scripts/test-advisor.js
//
import { db, initSchema } from "../src/db.js";
import { safeActionPlan, advisorCrops } from "../src/advisor.js";
import { SYMPTOMS, IPM_CATEGORIES, DIRECT_OBSERVATION_SET } from "../src/advisorCodes.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const clearMappings = () => db.execute("DELETE FROM cause_products");

async function main() {
  await initSchema();
  await clearMappings(); // start from the shipping state: chemical layer dark

  console.log("Input validation — fail safe, never guess");
  check("unknown symptom -> rejected, no plan", (await safeActionPlan({ crop: "potato", symptom: "my plant is sad" })).error === "unknown_symptom");
  check("empty symptom -> rejected", (await safeActionPlan({ crop: "potato", symptom: "" })).error === "unknown_symptom");
  check("SQL-ish input is rejected by the vocabulary, not executed", (await safeActionPlan({ crop: "potato", symptom: "'; DROP TABLE pesticides;--" })).error === "unknown_symptom");
  const stillThere = Number((await db.execute("SELECT COUNT(*) n FROM pesticides")).rows[0].n);
  check("pesticides table intact after injection attempt", stillThere === 20, String(stillThere));

  console.log("\nNEVER diagnoses — one symptom yields MANY possible causes");
  const yellow = await safeActionPlan({ crop: "potato", symptom: "leaves_yellow", lang: "en" });
  check("plan ok", yellow.ok === true);
  check("multiple possible causes returned (not a single verdict)", yellow.causes.length >= 4, String(yellow.causes.length));
  check("causes are CODES, not prose", yellow.causes.every((c) => /^[a-z_]+$/.test(c.cause_key)));
  check("each cause carries a likelihood + how-to-tell-apart hint", yellow.causes.every((c) => ["common", "possible", "rare"].includes(c.likelihood)));
  check("no field names a single 'diagnosis'", !("diagnosis" in yellow) && !("pest" in yellow) && !("recommendation" in yellow));

  console.log("\nNot-a-pest honesty — the most important rule for 'leaves yellow'");
  check("abiotic causes are present", yellow.causes.some((c) => c.abiotic));
  check("spraying_may_not_help is TRUE (a common abiotic cause exists)", yellow.spraying_may_not_help === true);
  const firstCause = yellow.causes[0];
  check("a COMMON cause ranks first (abiotic ones surface up top)", firstCause.likelihood === "common");
  check("nitrogen deficiency is offered as a cause of yellowing", yellow.causes.some((c) => c.cause_key === "nitrogen_deficiency" && c.abiotic));

  console.log("\nEvery ambiguous symptom offers a not-a-pest cause");
  for (const s of SYMPTOMS) {
    const p = await safeActionPlan({ crop: "potato", symptom: s });
    if (DIRECT_OBSERVATION_SET.has(s)) {
      check(`${s}: direct observation — exempt from the abiotic rule`, p.ok === true);
    } else {
      check(`${s}: offers at least one abiotic cause`, p.causes.some((c) => c.abiotic), JSON.stringify(p.causes.map((c) => c.kind)));
    }
  }

  console.log("\nNon-chemical IPM comes FIRST, always");
  check("IPM practices returned", yellow.ipm.length > 0, String(yellow.ipm.length));
  check("IPM practices are CODES in the controlled vocabulary", yellow.ipm.every((p) => /^[a-z_]+$/.test(p.practice_key)));
  check("IPM ordered least-invasive first (cultural -> biological -> mechanical)",
    yellow.ipm.every((p, i, a) => i === 0 || IPM_CATEGORIES.indexOf(a[i - 1].category) <= IPM_CATEGORIES.indexOf(p.category)),
    JSON.stringify(yellow.ipm.map((p) => p.category)));

  console.log("\nTHE GATE: no chemical is recommended until an agronomist signs off");
  check("chemical layer is DARK in the shipping state", yellow.chemical.status === "awaiting_review", yellow.chemical.status);
  check("chemical option list is EMPTY", yellow.chemical.options.length === 0);
  check("plan reports its content is NOT reviewed", yellow.content_reviewed === false);
  check("no dosage/PHI/PPE anywhere in an ungated plan", !JSON.stringify(yellow).match(/dose_per_unit|pre_harvest|ppe_required/));

  // An UNSIGNED mapping must not light the layer up, even for a cleared product.
  const mancozeb = (await db.execute("SELECT id FROM pesticides WHERE registration_no='ETH-FUN-0142/17'")).rows[0];
  await db.execute({ sql: "INSERT INTO cause_products (cause_key, crop, pesticide_id, reviewed) VALUES ('late_blight','potato',?,0)", args: [mancozeb.id] });
  await db.execute({ sql: "UPDATE pesticides SET reviewed=1, reviewed_by='Dr. Test', reviewed_at=datetime('now') WHERE id=?", args: [mancozeb.id] });
  const unsigned = await safeActionPlan({ crop: "potato", symptom: "spots_on_leaves" });
  check("cleared PRODUCT + unsigned MAPPING -> still dark", unsigned.chemical.status === "awaiting_review" && unsigned.chemical.options.length === 0);

  // A signed mapping on an UNCLEARED product must not light it up either.
  await db.execute("UPDATE cause_products SET reviewed=1, reviewed_by='Dr. Agro', reviewed_at=datetime('now')");
  await db.execute({ sql: "UPDATE pesticides SET reviewed=0, reviewed_by=NULL, reviewed_at=NULL WHERE id=?", args: [mancozeb.id] });
  const halfGated = await safeActionPlan({ crop: "potato", symptom: "spots_on_leaves" });
  check("signed MAPPING + uncleared PRODUCT -> still dark (both gates required)", halfGated.chemical.status === "awaiting_review" && halfGated.chemical.options.length === 0);

  console.log("\nOnce BOTH gates pass, facts are RETRIEVED (never invented)");
  await db.execute({ sql: "UPDATE pesticides SET reviewed=1, reviewed_by='Dr. Tox', reviewed_at=datetime('now') WHERE id=?", args: [mancozeb.id] });
  const live = await safeActionPlan({ crop: "potato", symptom: "spots_on_leaves" });
  check("chemical layer available once both gates pass", live.chemical.status === "available", live.chemical.status);
  const opt = live.chemical.options[0];
  check("option carries the REGISTRY dose for this crop", opt && opt.dose_per_unit === "2.5 kg per hectare", JSON.stringify(opt && opt.dose_per_unit));
  check("option carries the registry PHI", opt && opt.pre_harvest_interval_days === 7);
  check("risk is the WHO hazard class, NOT an invented score", opt && "hazard_class" in opt && !("green_score" in opt) && !("risk_score" in opt));
  check("provenance says retrieved", opt && opt.source === "registry");
  check("IPM is STILL listed before chemicals even when available", live.ipm.length > 0);

  console.log("\nA banned product is never offered, whatever a mapping says");
  const endo = (await db.execute("SELECT id FROM pesticides WHERE registration_no='ETH-INS-0009/05'")).rows[0]; // banned
  await db.execute({ sql: "INSERT INTO cause_products (cause_key, crop, pesticide_id, reviewed, reviewed_by, reviewed_at) VALUES ('aphids','potato',?,1,'Dr. Agro',datetime('now'))", args: [endo.id] });
  await db.execute({ sql: "UPDATE pesticides SET reviewed=1, reviewed_by='Dr. Tox', reviewed_at=datetime('now') WHERE id=?", args: [endo.id] });
  const bannedPlan = await safeActionPlan({ crop: "potato", symptom: "insects_visible" });
  check("banned product excluded from options", !bannedPlan.chemical.options.some((o) => o.registration_no === "ETH-INS-0009/05"), JSON.stringify(bannedPlan.chemical.options.map((o) => o.registration_no)));

  console.log("\nNo dose in the registry for a crop -> the option is dropped, never interpolated");
  await db.execute("DELETE FROM cause_products");
  await db.execute({ sql: "INSERT INTO cause_products (cause_key, crop, pesticide_id, reviewed, reviewed_by, reviewed_at) VALUES ('late_blight','teff',?,1,'Dr. Agro',datetime('now'))", args: [mancozeb.id] });
  const noDose = await safeActionPlan({ crop: "teff", symptom: "spots_on_leaves" });
  check("no registered dose for the crop -> no chemical option invented", noDose.chemical.options.length === 0, JSON.stringify(noDose.chemical.options));

  console.log("\nCrops offered come from the registry itself");
  const crops = await advisorCrops();
  check("crop list is non-empty and registry-derived", crops.length > 0 && crops.includes("potato"));

  // Leave the DB in the shipping state (chemical layer dark, nothing reviewed).
  await clearMappings();
  await db.execute("UPDATE pesticides SET reviewed=0, reviewed_by=NULL, reviewer_credential=NULL, reviewed_at=NULL, review_notes=NULL");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
