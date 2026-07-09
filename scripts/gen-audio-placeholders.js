// Generate ENGLISH PLACEHOLDER audio clips for the CANONICAL phrase set defined
// in docs/RECORDING_SCRIPT.md, using the macOS `say` command. These are dev
// placeholders only — real deployments ship native-speaker recordings (.mp3)
// named by the same keys into public/audio/{lang}/.
//
// No mp3 encoder is available locally (no ffmpeg/lame), so placeholders are
// .m4a (AAC), which every target browser plays. The manifest records the format
// so real .mp3 recordings can drop in later. See DECISIONS.md.
//
//   node scripts/gen-audio-placeholders.js
//
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = path.join(__dirname, "..", "public", "audio");
const LANGS = ["am", "om", "ti", "so", "aa"]; // recording languages: empty, await recordings
const FORMAT = "m4a";

// Canonical key -> English placeholder text (the "meaning to convey" column).
const PHRASES = {
  // 1. Verdicts
  verdict_verified: "This product is registered. It is safe to use as directed.",
  verdict_confirm: "Is this your product?",
  verdict_unregistered: "Warning. This product is not registered. It may be fake. Do not use it.",
  verdict_banned: "Stop. This product is banned. Do not use it.",
  verdict_expired: "Caution. This product's registration has expired. Do not use it until you check.",
  verdict_unconfirmed: "Could not confirm this product. Do not use it until it is checked.",
  verdict_offline: "No connection. Please try again when you have signal.",
  scanning: "Reading the label. Please wait.",

  // 2. Safety & dosage
  dose_is: "The correct amount is",
  wait_before_harvest: "Wait this many days before harvesting",
  days: "days",
  wear_protection: "Wear protection",
  ppe_gloves: "Gloves",
  ppe_mask: "Face mask",
  ppe_boots: "Boots",
  ppe_goggles: "Eye goggles",
  ppe_overall: "Long clothing that covers your body",
  hazard_unlikely: "This product is unlikely to be dangerous when used correctly.",
  hazard_low: "Low danger",
  hazard_moderate: "Moderate danger",
  hazard_high: "High danger",
  hazard_extreme: "Extreme danger",
  crop_not_covered: "This product is not approved for that crop. Ask your extension agent.",
  ask_agent: "Contact your extension agent",
  disclaimer: "This is official information. If you are unsure, ask your extension agent.",
  replay: "Listen again",

  // 3. Emergency
  emergency_title: "Emergency. Poisoning help.",
  emergency_ask_route: "How did the poison touch the person?",
  route_skin: "On the skin",
  route_eyes: "In the eyes",
  route_swallowed: "Swallowed",
  route_breathed: "Breathed in",
  emergency_call_help: "Call for help now",
  emergency_next_step: "Next step",
  emergency_stay_calm: "Stay calm. Follow these steps.",

  // Universal first-aid steps
  aid_move_air: "Move the person to fresh air, away from the chemical.",
  aid_remove_clothes: "Remove any clothing that has the chemical on it.",
  aid_rinse_skin: "Rinse the skin with clean running water for twenty minutes.",
  aid_rinse_eyes: "Rinse the eyes with clean running water for twenty minutes. Keep the eye open.",
  aid_do_not_vomit: "Do not make the person vomit.",
  aid_no_food_drink: "Do not give food or drink.",
  aid_keep_container: "Keep the pesticide container to show the health worker.",
  aid_seek_help: "Take the person to a health centre immediately.",
  aid_if_unconscious: "If the person is not awake, lay them on their side and get help immediately.",

  // 4. Units (numbers added below)
  point: "point",
  unit_ml_per_litre: "millilitres per litre",
  unit_g_per_litre: "grams per litre",
  unit_kg_per_hectare: "kilograms per hectare",
  unit_l_per_hectare: "litres per hectare",
  unit_ml_per_knapsack: "millilitres per knapsack sprayer",

  // 5. Navigation
  scan_bottle: "Scan a bottle",
  yes: "Yes",
  no: "No",
  next: "Next",
  back: "Back",
  try_again: "Try again",
  choose_crop: "Choose your crop",
};

// Numbers: 0–20, then the tens 30..100 (21–99 are composed tens+ones at runtime).
const NUMBERS = [...Array.from({ length: 21 }, (_, i) => i), 30, 40, 50, 60, 70, 80, 90, 100];
for (const n of NUMBERS) PHRASES[`num_${n}`] = String(n);

function say(text, outPath) {
  execFileSync("say", ["-o", outPath, text], { stdio: "ignore" });
}

function main() {
  const enDir = path.join(AUDIO, "en");
  fs.rmSync(enDir, { recursive: true, force: true }); // clear stale keys
  fs.mkdirSync(enDir, { recursive: true });

  const keys = Object.keys(PHRASES);
  let made = 0;
  for (const key of keys) {
    say(PHRASES[key], path.join(enDir, `${key}.${FORMAT}`));
    if (++made % 20 === 0) console.log(`  ...${made}/${keys.length}`);
  }

  for (const lang of LANGS) {
    const dir = path.join(AUDIO, lang);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  }

  const manifest = {
    _note:
      "English clips are PLACEHOLDERS generated by macOS `say` (.m4a/AAC — no local mp3 encoder). " +
      "Keys are the canonical set from docs/RECORDING_SCRIPT.md. English uses the Web Speech TTS " +
      "bridge and needs no recordings. The five recording-language folders (am, om, ti, so, aa) are " +
      "empty, awaiting native-speaker recordings (.mp3). Nothing in the app assumes any language's " +
      "clips exist; missing clips degrade to icon + colour + text.",
    format: FORMAT,
    formats: { en: FORMAT },
    languages: { en: keys, am: [], om: [], ti: [], so: [], aa: [] },
  };
  fs.writeFileSync(path.join(AUDIO, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Generated ${made} English placeholder clips (.${FORMAT}) + manifest.`);
  console.log(`Empty folders created for: ${LANGS.join(", ")}`);
}

main();
