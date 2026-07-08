import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, dbMode, initSchema } from "../src/db.js";

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
  await db.executeMultiple(
    "DELETE FROM dosages; DELETE FROM pesticides; DELETE FROM extension_agents;"
  );
}

async function insertPesticide(p) {
  await db.execute({
    sql: `INSERT INTO pesticides
      (id, registration_no, product_name, active_ingredient, formulation, registrant,
       registration_date, expiry_date, status, hazard_class, ppe_required, first_aid, approved_crops)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

  const p = await db.execute("SELECT COUNT(*) AS n FROM pesticides");
  const d = await db.execute("SELECT COUNT(*) AS n FROM dosages");
  const banned = await db.execute("SELECT COUNT(*) AS n FROM pesticides WHERE status='banned'");

  console.log(`Seeded from ${result.source} (db: ${dbMode})`);
  console.log(`  pesticides: ${Number(p.rows[0].n)}`);
  console.log(`  dosages:    ${Number(d.rows[0].n)}`);
  console.log(`  banned:     ${Number(banned.rows[0].n)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
