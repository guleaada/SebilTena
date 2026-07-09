import { SUPPORTED_LANGS } from "../localize.js";

// ---------------------------------------------------------------------------
// Inbound SMS parsing: commands + route words in all six languages.
//
// Route recognition is a small FIXED vocabulary (not safety data). English
// words and 1-4 numeric shortcuts always work; localized words are best-effort.
// ti/so/sid/wal words need native review (see DECISIONS.md). Panic types short,
// so we are case-insensitive, whitespace-tolerant, and accept bare route words.
// ---------------------------------------------------------------------------

const ROUTE_SYNONYMS = {
  skin: ["skin", "1", "gogaa", "ቆዳ", "maqaarka", "maqaar", "ቆርበት", "galba", "goga"],
  eyes: ["eyes", "eye", "2", "ija", "ዓይን", "indhaha", "indho", "ዓይኒ", "ilʼe"],
  swallowed: ["swallowed", "swallow", "3", "liqimse", "ተውጦ", "ዋጠ", "liqday", "cabbay", "ወሓጠ", "agulte"],
  breathed: ["breathed", "breath", "inhaled", "inhale", "4", "hargane", "ተነፈሰ", "ትንፋሽ", "neefsaday", "neef", "ኣተንፈሰ", "shittuu"],
};

const ROUTE_LOOKUP = new Map();
for (const [route, words] of Object.entries(ROUTE_SYNONYMS)) {
  for (const w of words) ROUTE_LOOKUP.set(w.toLowerCase(), route);
}

export function resolveRoute(word) {
  if (!word) return null;
  return ROUTE_LOOKUP.get(String(word).trim().toLowerCase()) || null;
}

// Normalize a registration-number-like token: uppercase, keep alphanumerics
// plus the common separators, collapse whitespace.
export function looksLikeRegNo(token) {
  const t = String(token || "").trim();
  return /\d/.test(t) && t.length >= 3 && t.length <= 24 && /^[A-Za-z0-9\/\- ]+$/.test(t);
}

/**
 * Parse a sanitized inbound message into a command.
 * @returns {{type, route?, lang?, crop?, regNo?}}
 *   types: HELP | ROUTE | LANG | CROP | REGNO | UNKNOWN
 */
export function parseCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return { type: "UNKNOWN" };

  const parts = raw.split(/\s+/);
  const head = parts[0].toUpperCase();
  const rest = parts.slice(1).join(" ").trim();

  // HELP, optionally with a route ("HELP SWALLOWED")
  if (head === "HELP") {
    const route = rest ? resolveRoute(rest.split(/\s+/)[0]) : null;
    return { type: "HELP", route };
  }

  // LANG <code>
  if (head === "LANG") {
    const code = (rest.split(/\s+/)[0] || "").toLowerCase();
    return { type: "LANG", lang: SUPPORTED_LANGS.includes(code) ? code : null, raw: rest };
  }

  // CROP <name>
  if (head === "CROP") {
    return { type: "CROP", crop: rest };
  }

  // Bare route word (accepts a leading route in any language)
  const bareRoute = resolveRoute(head) || resolveRoute(raw);
  if (bareRoute) return { type: "ROUTE", route: bareRoute };

  // Registration-number attempt
  if (looksLikeRegNo(raw)) return { type: "REGNO", regNo: raw };

  return { type: "UNKNOWN" };
}
