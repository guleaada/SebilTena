import { config } from "./config.js";

// ---------------------------------------------------------------------------
// FORMAT-AGNOSTIC ANCHOR MATCH (Section 4)
//
// The M1 registration-number format is a placeholder, so we do NOT match on a
// fixed regex. Instead we take whatever tokens/lines came off the label (from
// Tesseract or the vision model) and match them against the registry across
// THREE columns — registration_no, product_name, active_ingredient.
//
// A miss across all three is itself the counterfeit / unregistered signal.
//
// This module is pure (registry passed in) so it is unit-testable without a DB.
// It only ever returns an IDENTITY candidate + a tier — never a safety value.
// ---------------------------------------------------------------------------

// Uppercase, keep only alphanumerics. Collapses "ETH-FUN-0142/17",
// "ETH FUN 0142 17", "eth/fun/0142-17" all to "ETHFUN014217".
export function normalizeRegNo(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Character-bigram Dice coefficient (0..1). Lightweight, dependency-free,
// forgiving of OCR noise and word-order.
function bigrams(s) {
  const t = String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

/**
 * @param {string[]} candidateStrings  tokens and/or lines read off the label
 * @param {Array<{id,registration_no,product_name,active_ingredient}>} registry
 * @returns {{tier:1|2|3, confidence:'high'|'medium'|'low', pesticide:object|null,
 *            matchedOn:string|null, matchedValue:string|null, score:number}}
 */
export function matchAnchor(candidateStrings, registry) {
  const strings = (candidateStrings || []).map((s) => String(s || "")).filter((s) => s.trim().length > 0);
  const miss = { tier: 3, confidence: "low", pesticide: null, matchedOn: null, matchedValue: null, score: 0 };
  if (strings.length === 0 || !registry || registry.length === 0) return miss;

  // ---- Tier 1: exact registration-number match ------------------------------
  // Match against a normalized blob of everything read, so OCR splitting the
  // number across tokens ("ETH", "FUN", "0142", "17") still resolves.
  const blob = normalizeRegNo(strings.join(" "));
  for (const row of registry) {
    const regNorm = normalizeRegNo(row.registration_no);
    if (regNorm.length >= config.regNoMinLen && blob.includes(regNorm)) {
      return {
        tier: 1,
        confidence: "high",
        pesticide: row,
        matchedOn: "registration_no",
        matchedValue: row.registration_no,
        score: 1,
      };
    }
  }

  // ---- Tier 2: fuzzy product-name / active-ingredient match -----------------
  const joined = strings.join(" ");
  let best = { row: null, score: 0, on: null, val: null };
  for (const row of registry) {
    for (const [field, value] of [
      ["product_name", row.product_name],
      ["active_ingredient", row.active_ingredient],
    ]) {
      if (!value) continue;
      // Compare each individual line/token AND the whole joined read; take max.
      let s = similarity(joined, value);
      for (const cand of strings) {
        const sc = similarity(cand, value);
        if (sc > s) s = sc;
      }
      if (s > best.score) best = { row, score: s, on: field, val: value };
    }
  }

  if (best.row && best.score >= config.fuzzyThreshold) {
    return {
      tier: 2,
      confidence: "medium",
      pesticide: best.row,
      matchedOn: best.on,
      matchedValue: best.val,
      score: Number(best.score.toFixed(3)),
    };
  }

  // ---- Tier 3: miss ---------------------------------------------------------
  return miss;
}

// Split raw OCR/label text into candidate strings: whole lines (for name/AI
// fuzzy matching) plus alphanumeric tokens (for reg-no assembly).
export function buildCandidates(text) {
  const raw = String(text || "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);
  const tokens = raw
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((tk) => tk.length >= 2);
  return { lines, tokens, all: [...lines, ...tokens] };
}

// Best-effort "what number did we read" for logging/display — the longest
// alphanumeric token that contains a digit. Never used for matching decisions.
export function extractRegCandidate(text) {
  const { tokens } = buildCandidates(text);
  let best = null;
  for (const tk of tokens) {
    if (/\d/.test(tk) && (!best || tk.length > best.length)) best = tk;
  }
  return best;
}
