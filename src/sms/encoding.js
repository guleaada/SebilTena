// ---------------------------------------------------------------------------
// SMS ENCODING (M5 Section 0)
//
// GSM-7 gives 160 chars/segment (153 when concatenated) but ONLY for its Latin
// alphabet. Ethiopic script (Amharic, Tigrinya, Sidaamu Afoo) is not in GSM-7,
// so those replies are UCS-2: 70 chars/segment (67 concatenated). Somali and
// Afaan Oromo are Latin -> GSM-7. Budgets differ PER LANGUAGE; the reply builder
// must front-load the verdict and fit to a small number of segments.
// ---------------------------------------------------------------------------

// GSM 03.38 basic alphabet (each char = 1 septet). Includes \n, \r, ESC (\x1b).
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// Extension table (each char = 2 septets: ESC + char).
const GSM7_EXT = "\f^{}\\[~]|€";

const BASIC_SET = new Set([...GSM7_BASIC]);
const EXT_SET = new Set([...GSM7_EXT]);

// Septet count if the whole string is GSM-7-representable, else -1.
function gsm7Septets(text) {
  let septets = 0;
  for (const ch of String(text)) {
    if (BASIC_SET.has(ch)) septets += 1;
    else if (EXT_SET.has(ch)) septets += 2;
    else return -1;
  }
  return septets;
}

/** 'GSM7' if every character is GSM-7-representable, else 'UCS2'. */
export function detectEncoding(text) {
  return gsm7Septets(text) >= 0 ? "GSM7" : "UCS2";
}

/** Number of SMS segments the text needs (single vs concatenated sizing). */
export function segmentCount(text) {
  const s = String(text || "");
  const septets = gsm7Septets(s);
  if (septets >= 0) {
    if (septets <= 160) return septets === 0 ? 0 : 1;
    return Math.ceil(septets / 153);
  }
  // UCS-2 counts UTF-16 code units (JS string length).
  const units = s.length;
  if (units <= 70) return units === 0 ? 0 : 1;
  return Math.ceil(units / 67);
}

// Character budget for a whole message of N segments, given encoding.
export function segmentBudget(maxSegments, encoding) {
  if (encoding === "UCS2") return maxSegments <= 1 ? 70 : maxSegments * 67;
  return maxSegments <= 1 ? 160 : maxSegments * 153;
}

/**
 * Trim `text` from the END so it fits within `maxSegments`. The verdict must be
 * front-loaded by the caller, so trimming the tail never drops it. Cuts on a
 * word boundary when one is reasonably close. `lang` is accepted for signature
 * completeness; fitting is driven by the detected encoding, not the language.
 */
export function fitToSegments(text, maxSegments, lang) {
  let s = String(text || "");
  if (segmentCount(s) <= maxSegments) return s;

  const enc = detectEncoding(s);
  // Start near the budget, then shrink until it fits (handles ext chars etc.).
  let limit = segmentBudget(maxSegments, enc);
  s = s.slice(0, limit);
  while (s.length > 0 && segmentCount(s) > maxSegments) {
    s = s.slice(0, s.length - 1);
  }
  // Back off to a word boundary if it doesn't cost too much.
  const lastSpace = s.lastIndexOf(" ");
  if (lastSpace > s.length * 0.6) s = s.slice(0, lastSpace);
  return s.trim();
}
