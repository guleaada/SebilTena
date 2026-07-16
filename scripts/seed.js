import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbMode, initSchema } from "../src/db.js";
import { validateFirstAid } from "../src/aidCodes.js";
import { validateCause, validatePractice, DIRECT_OBSERVATION_SET } from "../src/advisorCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");

const CSV_PATH = path.join(DATA, "registered_pesticides.csv");
const XLSX_PATH = path.join(DATA, "registered_pesticides.xlsx");
const SAMPLE_PATH = path.join(DATA, "sample_pesticides.json");

// ---------------------------------------------------------------------------
// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes,
// commas and newlines inside quotes). Avoids adding a dependency for M1.
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore; \n handles the break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Flexible header -> schema mapping. Accepts several likely column names so the
// real MoA list can be ingested with minimal edits (finalize when it arrives).
const COLUMN_ALIASES = {
  registration_no: ["registration_no", "registration number", "reg_no", "reg no", "regno"],
  product_name: ["product_name", "product name", "trade name", "trade_name", "product"],
  active_ingredient: ["active_ingredient", "active ingredient", "active", "ai"],
  formulation: ["formulation", "formulation type", "type"],
  registrant: ["registrant", "company", "applicant"],
  registration_date: ["registration_date", "registration date", "date of registration"],
  expiry_date: ["expiry_date", "expiry date", "expiry", "valid until"],
  status: ["status"],
  hazard_class: ["hazard_class", "hazard class", "who class", "who_hazard"],
  ppe_required: ["ppe_required", "ppe"],
  first_aid: ["first_aid", "first aid"],
  approved_crops: ["approved_crops", "approved crops", "crops"],
};

function buildHeaderMap(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = norm.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

async function resetSeedTables() {
  // Reset only the seedable ground-truth tables. `scans` (audit log) is kept.
  // The M13 advisor content tables are reset too: a re-seed deliberately clears
  // their `reviewed` flags, so the review gate RE-ENGAGES (fails safe) rather
  // than carrying a stale sign-off onto replaced content.
  await db.executeMultiple(
    "DELETE FROM dosages; DELETE FROM pesticides; DELETE FROM extension_agents;" +
    "DELETE FROM symptom_causes; DELETE FROM ipm_practices; DELETE FROM cause_products;"
  );
}

// Seed the Safe Action Plan content (M13). Every row is validated against the
// controlled vocabulary (src/advisorCodes.js) and FAILS LOUDLY on a bad code — a
// bad code would surface to a farmer as a missing or wrong string. Everything
// seeds `reviewed = 0`: the content is illustrative and NOT agronomist-approved,
// so the chemical layer stays dark and the plan is labelled unreviewed.
async function seedAdvisor() {
  const path_ = path.join(DATA, "advisor_seed.json");
  if (!fs.existsSync(path_)) return { causes: 0, practices: 0, causeProducts: 0 };
  const doc = JSON.parse(fs.readFileSync(path_, "utf8"));

  const errors = [];
  for (const c of doc.symptom_causes ?? []) errors.push(...validateCause(c, `symptom_cause ${c.symptom_key}/${c.cause_key}`));
  for (const p of doc.ipm_practices ?? []) errors.push(...validatePractice(p, `ipm_practice ${p.cause_key}/${p.practice_key}`));
  if (errors.length) throw new Error("Invalid advisor seed data:\n  " + errors.join("\n  "));

  // Every AMBIGUOUS symptom MUST offer at least one abiotic (not-a-pest) cause —
  // the plan's honesty depends on it, and "leaves yellow" is most often a
  // fertility/water problem no spray can fix. Direct-observation symptoms (the
  // farmer can see the insect) are exempt: there is no honest abiotic cause, and
  // faking one to satisfy a rule would be worse than not having it. Enforced at
  // seed time so the rule cannot silently rot as content is replaced.
  const bySymptom = {};
  for (const c of doc.symptom_causes ?? []) (bySymptom[c.symptom_key] ||= []).push(c);
  for (const [sym, rows] of Object.entries(bySymptom)) {
    if (DIRECT_OBSERVATION_SET.has(sym)) continue;
    if (!rows.some((r) => r.kind === "abiotic")) {
      throw new Error(`Advisor seed: symptom "${sym}" has no abiotic cause. Every ambiguous symptom must show at least one cause a pesticide cannot fix (see SAFETY.md / advisorCodes.js).`);
    }
  }

  for (const c of doc.symptom_causes ?? []) {
    await db.execute({
      sql: `INSERT INTO symptom_causes (symptom_key, crop, cause_key, kind, likelihood, distinguish_key, reviewed)
            VALUES (?,?,?,?,?,?,0)`,
      args: [c.symptom_key, c.crop ?? null, c.cause_key, c.kind, c.likelihood, c.distinguish_key ?? null],
    });
  }
  for (const p of doc.ipm_practices ?? []) {
    await db.execute({
      sql: "INSERT INTO ipm_practices (cause_key, crop, category, practice_key, step_order, reviewed) VALUES (?,?,?,?,?,0)",
      args: [p.cause_key, p.crop ?? null, p.category, p.practice_key, p.step_order ?? 0],
    });
  }
  // cause_products is intentionally empty in the seed: the chemical layer only
  // ever lights up from agronomist-signed mappings, never from shipped defaults.
  for (const cp of doc.cause_products ?? []) {
    await db.execute({
      sql: "INSERT INTO cause_products (cause_key, crop, pesticide_id, reviewed) VALUES (?,?,?,0)",
      args: [cp.cause_key, cp.crop, cp.pesticide_id],
    });
  }
  return {
    causes: (doc.symptom_causes ?? []).length,
    practices: (doc.ipm_practices ?? []).length,
    causeProducts: (doc.cause_products ?? []).length,
  };
}

async function insertPesticide(p) {
  // Validate first_aid against the controlled vocabulary. Fail LOUDLY — a bad
  // code must never reach the DB (it would surface silently in an emergency).
  const errors = validateFirstAid(p.first_aid ?? {}, `${p.product_name} (${p.registration_no})`);
  if (errors.length) {
    throw new Error("Invalid first_aid in seed data:\n  " + errors.join("\n  "));
  }
  await db.execute({
    sql: `INSERT INTO pesticides
      (id, registration_no, product_name, active_ingredient, formulation, registrant,
       registration_date, expiry_date, status, hazard_class, ppe_required, first_aid, approved_crops, reviewed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      p.id ?? null,
      p.registration_no,
      p.product_name,
      p.active_ingredient,
      p.formulation ?? null,
      p.registrant ?? null,
      p.registration_date ?? null,
      p.expiry_date ?? null,
      p.status ?? "registered",
      p.hazard_class ?? null,
      JSON.stringify(p.ppe_required ?? []),
      JSON.stringify(p.first_aid ?? {}),
      JSON.stringify(p.approved_crops ?? []),
      p.reviewed === true ? 1 : 0,
    ],
  });
}

async function insertDosage(pesticideId, d) {
  await db.execute({
    sql: `INSERT INTO dosages
      (pesticide_id, crop, dose_per_unit, application_notes, pre_harvest_interval_days)
      VALUES (?,?,?,?,?)`,
    args: [
      pesticideId,
      d.crop,
      d.dose_per_unit,
      d.application_notes ?? null,
      d.pre_harvest_interval_days ?? null,
    ],
  });
}

async function seedSamples() {
  const doc = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  for (const agent of doc.extension_agents ?? []) {
    await db.execute({
      sql: "INSERT INTO extension_agents (id, name, phone, region) VALUES (?,?,?,?)",
      args: [agent.id ?? null, agent.name, agent.phone, agent.region],
    });
  }
  let dosageCount = 0;
  for (const p of doc.pesticides) {
    await insertPesticide(p);
    for (const d of p.dosages ?? []) {
      await insertDosage(p.id, d);
      dosageCount++;
    }
  }
  return { pesticides: doc.pesticides.length, dosages: dosageCount, source: "sample_pesticides.json" };
}

async function seedFromCSV() {
  const rows = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
  if (rows.length < 2) throw new Error("CSV appears empty.");
  const map = buildHeaderMap(rows[0]);
  if (map.registration_no == null || map.product_name == null || map.active_ingredient == null) {
    throw new Error(
      "CSV missing required columns (registration_no, product_name, active_ingredient). Found headers: " +
        rows[0].join(", ")
    );
  }
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = (field) => (map[field] != null ? (r[map[field]] ?? "").trim() : "");
    const p = {
      registration_no: cell("registration_no"),
      product_name: cell("product_name"),
      active_ingredient: cell("active_ingredient"),
      formulation: cell("formulation") || null,
      registrant: cell("registrant") || null,
      registration_date: cell("registration_date") || null,
      expiry_date: cell("expiry_date") || null,
      status: (cell("status") || "registered").toLowerCase(),
      hazard_class: cell("hazard_class") || null,
      // These arrive as delimited strings in the real list; store as JSON.
      ppe_required: cell("ppe_required") ? cell("ppe_required").split(/[;|]/).map((s) => s.trim()) : [],
      first_aid: cell("first_aid") ? tryJSON(cell("first_aid")) : {},
      approved_crops: cell("approved_crops") ? cell("approved_crops").split(/[;|]/).map((s) => s.trim()) : [],
    };
    if (!p.registration_no) continue;
    if (!["registered", "banned", "suspended"].includes(p.status)) p.status = "registered";
    await insertPesticide({ ...p, id: null });
    count++;
  }
  return { pesticides: count, dosages: 0, source: "registered_pesticides.csv" };
}

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { note: s };
  }
}

async function main() {
  await initSchema();
  await resetSeedTables();

  if (fs.existsSync(XLSX_PATH) && !fs.existsSync(CSV_PATH)) {
    console.warn(
      "Found registered_pesticides.xlsx but XLSX ingestion is not implemented yet.\n" +
        "Export it to data/registered_pesticides.csv and re-run. Falling back to sample data."
    );
  }

  const result = fs.existsSync(CSV_PATH) ? await seedFromCSV() : await seedSamples();
  const advisor = await seedAdvisor(); // M13 Safe Action Plan content (all reviewed:false)

  const p = await db.execute("SELECT COUNT(*) AS n FROM pesticides");
  const d = await db.execute("SELECT COUNT(*) AS n FROM dosages");
  const banned = await db.execute("SELECT COUNT(*) AS n FROM pesticides WHERE status='banned'");

  console.log(`Seeded from ${result.source} (db: ${dbMode})`);
  console.log(`  pesticides: ${Number(p.rows[0].n)}`);
  console.log(`  dosages:    ${Number(d.rows[0].n)}`);
  console.log(`  banned:     ${Number(banned.rows[0].n)}`);
  console.log(`  advisor:    ${advisor.causes} symptom-causes, ${advisor.practices} IPM practices, ${advisor.causeProducts} cause->product mappings (all reviewed:false)`);
  if (advisor.causeProducts === 0) {
    console.log("  NOTE: the advisor's chemical layer is DARK — it stays hidden until an agronomist signs cause->product mappings via /admin/review (SAFETY.md).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
