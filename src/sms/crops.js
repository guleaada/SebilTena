import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LANGS } from "../localize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(__dirname, "..", "..", "locales");

// Reverse map: any language's crop name (and the raw key) -> crop key. Lets a
// farmer text "potato" or "ድንች" or "dinnicha" and get the same crop key. This is
// identity resolution over a fixed vocabulary, not a safety value.
let MAP = null;
function build() {
  const m = new Map();
  for (const lang of SUPPORTED_LANGS) {
    try {
      const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), "utf8"));
      const crops = dict.crop || {};
      for (const [key, label] of Object.entries(crops)) {
        m.set(key.toLowerCase(), key);
        if (typeof label === "string") m.set(label.trim().toLowerCase(), key);
      }
    } catch {
      /* ignore missing/invalid locale */
    }
  }
  return m;
}

export function resolveCrop(word) {
  if (!MAP) MAP = build();
  if (!word) return null;
  return MAP.get(String(word).trim().toLowerCase()) || null;
}
