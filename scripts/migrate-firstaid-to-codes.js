// One-time migration: convert data/sample_pesticides.json first_aid prose into
// controlled aid_* step-code arrays (M4.5 Part A) and add reviewed:false.
// Deterministic + re-runnable (idempotent: already-array first_aid is left as-is
// aside from re-validation). Mapping is by hazard/ingredient profile.
//
//   node scripts/migrate-firstaid-to-codes.js
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFirstAid } from "../src/aidCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "sample_pesticides.json");

const HIGH_INGREDIENT = /malathion|chlorpyrifos|diazinon|profenofos|dimethoate|parathion|carbofuran|paraquat|endosulfan|ddt|cypermethrin|deltamethrin|lambda/i;

function codesFor(p) {
  const high =
    ["Ia", "Ib"].includes(p.hazard_class) ||
    ["banned", "suspended"].includes(p.status) ||
    HIGH_INGREDIENT.test(p.active_ingredient || "");

  const skin = ["aid_remove_clothes", "aid_rinse_skin"];
  if (high) skin.push("aid_keep_container");
  skin.push("aid_seek_help");

  const eyes = ["aid_rinse_eyes", "aid_seek_help"];

  const swallowed = ["aid_do_not_vomit", "aid_no_food_drink", "aid_keep_container", "aid_seek_help"];
  if (high) swallowed.push("aid_if_unconscious");

  const breathed = ["aid_move_air", "aid_seek_help"];
  if (high) breathed.push("aid_if_unconscious");

  return { skin, eyes, swallowed, breathed };
}

const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
let migrated = 0;
for (const p of doc.pesticides) {
  const codes = codesFor(p);
  const errors = validateFirstAid(codes, p.product_name);
  if (errors.length) { console.error("VALIDATION FAILED:", errors); process.exit(1); }
  p.first_aid = codes;
  p.reviewed = false; // toxicologist sign-off pending (SAFETY.md release gate)
  migrated++;
}

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
console.log(`Migrated ${migrated} products to aid_* step codes + reviewed:false.`);
console.log("Sample (product 1):", JSON.stringify(doc.pesticides[0].first_aid));
console.log("Sample (banned Endosulfan):", JSON.stringify(doc.pesticides.find((x) => /endosulfan/i.test(x.active_ingredient)).first_aid));
