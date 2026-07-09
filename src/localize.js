import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "locales");
const FALLBACK = "en";

export const SUPPORTED_LANGS = ["am", "om", "ti", "so", "aa", "en"];

const cache = new Map();

function load(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  let dict = null;
  if (fs.existsSync(file)) {
    dict = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  cache.set(lang, dict);
  return dict;
}

function get(obj, dottedKey) {
  if (!obj) return undefined;
  return dottedKey
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Translate a dotted key for a language, falling back to English, then the
// raw key. Only ever used for UI/status strings — never for dosage, first-aid,
// PPE or PHI values, which are stored facts (see SAFETY.md).
export function t(lang, key) {
  const primary = get(load(lang), key);
  if (primary != null) return primary;
  const fallback = get(load(FALLBACK), key);
  if (fallback != null) return fallback;
  return key;
}

export function normalizeLang(lang) {
  const l = (lang || "").toLowerCase().trim();
  return SUPPORTED_LANGS.includes(l) ? l : FALLBACK;
}
