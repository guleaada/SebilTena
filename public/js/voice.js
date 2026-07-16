/* ==========================================================================
   VOICE SYMPTOM INPUT (M14) — pure, deterministic matching of a spoken phrase
   onto the advisor's CONTROLLED SYMPTOM VOCABULARY (src/advisorCodes.js).

   THE BOUNDARY (SAFETY.md — "the AI is a RETRIEVER, not an ADVISER"):
   Speech recognition is an INPUT method, never a source of meaning. This module
   can only ever return a symptom CODE that was already in the allowed set, or
   nothing at all. A transcript never becomes free text that reaches a plan, a
   dose, or a product — it selects a menu item the farmer could equally have
   tapped, and the server re-validates the code against SYMPTOM_SET regardless.

   CONSERVATIVE FAILURE MODES (the whole point of this file):
     * Two symptoms match  -> "ambiguous". We do NOT rank, score or guess; the
       farmer disambiguates. "Insects made holes in my leaves" is genuinely two
       symptoms and only the farmer knows which one they mean.
     * Nothing matches     -> "none". The menu is still right there.
     * Anything unexpected -> "none". Never a symptom picked on a hunch.
   A wrong symptom yields wrong IPM guidance, so a miss must cost a tap, never a
   silent mis-selection.

   Pure by construction (no DOM, no SpeechRecognition, no network) so every rule
   below is unit-tested in Node against real transcripts — scripts/test-voice.js.
   The browser plumbing lives in app.js, exactly as quality.js is pure and the
   camera lives in app.js.
   ========================================================================== */
window.VoiceMatch = (() => {
  "use strict";

  // ---- Ge'ez homophone folding -------------------------------------------
  // Amharic writes several distinct characters for one modern sound, and a
  // speech recognizer picks ONE spelling while our reviewed alias may use
  // another — so "ጸሐይ" and "ፀሓይ" must compare equal or matching silently fails.
  // Each entry folds a whole 7-order family onto its canonical family:
  //   ሐ/ኀ -> ሀ (h) · ሠ -> ሰ (s) · ዐ -> አ (ʾa) · ፀ -> ጸ (tsʼ)
  // Orders are laid out contiguously in the Ge'ez block, so the offset within
  // the family carries over unchanged (ሓ is ሐ+3 -> ሃ is ሀ+3).
  const GEEZ_FOLD = [
    [0x1210, 0x1200], // ሐ family -> ሀ family
    [0x1280, 0x1200], // ኀ family -> ሀ family
    [0x1220, 0x1230], // ሠ family -> ሰ family
    [0x12d0, 0x12a0], // ዐ family -> አ family
    [0x1340, 0x1338], // ፀ family -> ጸ family
  ];
  const GEEZ_ORDERS = 7; // ä u i a e ə o

  function foldGeez(s) {
    let out = "";
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      let mapped = ch;
      for (const [from, to] of GEEZ_FOLD) {
        if (c >= from && c < from + GEEZ_ORDERS) {
          mapped = String.fromCodePoint(to + (c - from));
          break;
        }
      }
      out += mapped;
    }
    return out;
  }

  /**
   * Canonical form for comparison: fold Ge'ez homophones, lowercase (a no-op for
   * Ge'ez, which is unicameral), drop punctuation — recognizers freely add commas
   * and the Oromo orthography uses ` as a glottal stop — and collapse whitespace.
   */
  function normalize(s) {
    if (s == null) return "";
    return foldGeez(String(s))
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Does `needle` occur in `haystack` at a WORD START?
   *
   * The left edge is anchored, the right edge is free. That asymmetry is
   * deliberate: it lets a short stem match inflections ("wilt" hits "wilting",
   * "spot" hits "spots") while refusing accidental hits inside a longer word
   * ("hole" must NOT hit "whole", or "the whole plant is wilting" would report
   * holes in leaves). Both strings are already normalized.
   */
  function phraseHit(haystack, needle) {
    if (!needle) return false;
    for (let from = 0; ; ) {
      const i = haystack.indexOf(needle, from);
      if (i < 0) return false;
      if (i === 0 || haystack[i - 1] === " ") return true;
      from = i + 1;
    }
  }

  /**
   * Match a spoken transcript onto exactly one symptom code, or refuse.
   *
   * @param {string} transcript  what the recognizer heard
   * @param {object} aliasMap    { symptom_code: ["reviewed spoken phrase", ...] }
   * @param {Iterable<string>} allowed  the ONLY codes that may be returned —
   *        pass the server's own symptom list, so a stale locale can never
   *        introduce a code the backend would reject.
   * @returns {{status:"match"|"ambiguous"|"none", symptom:string|null, candidates:string[]}}
   */
  function matchSymptom(transcript, aliasMap, allowed) {
    const empty = { status: "none", symptom: null, candidates: [] };
    const norm = normalize(transcript);
    if (!norm) return empty;

    const allow = allowed instanceof Set ? allowed : new Set(allowed || []);
    if (!allow.size || !aliasMap || typeof aliasMap !== "object") return empty;

    // An EXACT whole-transcript hit beats substring hits: a farmer who says
    // precisely "yellow leaves" means that symptom even though other aliases may
    // also appear inside a longer sentence. Anything less exact stays ambiguous.
    const exact = new Set();
    const partial = new Set();

    for (const code of Object.keys(aliasMap)) {
      if (!allow.has(code)) continue; // GUARD: never emit a code outside the vocabulary
      const list = aliasMap[code];
      if (!Array.isArray(list)) continue;
      for (const alias of list) {
        const na = normalize(alias);
        if (!na) continue;
        if (na === norm) { exact.add(code); break; }
        if (phraseHit(norm, na)) { partial.add(code); }
      }
    }

    const hits = [...(exact.size ? exact : partial)];
    if (hits.length === 1) return { status: "match", symptom: hits[0], candidates: hits };
    if (hits.length > 1) return { status: "ambiguous", symptom: null, candidates: hits };
    return empty;
  }

  // ---- Recognizer language tags ------------------------------------------
  // BCP-47 tags for the Web Speech API. A tag here is a REQUEST, not a promise:
  // support varies by browser, device and version, and we cannot enumerate it
  // (the API offers no capability query — it simply fails at recognition time
  // with `language-not-supported`). app.js treats that error as final for the
  // session and hides the mic, so an unsupported language degrades to the menu
  // rather than to a button that does nothing.
  //
  // `null` = we do not even ask. aa (Afar) has no recognizer we know of, and
  // offering a mic that always fails is worse than offering no mic.
  const LANG_TAGS = { en: "en-US", am: "am-ET", om: "om-ET", ti: "ti-ET", so: "so-SO", aa: null };

  const recognitionTag = (lang) => LANG_TAGS[String(lang || "").toLowerCase()] || null;

  /** Is a SpeechRecognition implementation present at all? (`win` injected for tests.) */
  function supported(win) {
    const w = win || (typeof window !== "undefined" ? window : null);
    return !!(w && (w.SpeechRecognition || w.webkitSpeechRecognition));
  }

  /**
   * May we offer the mic right now? Every condition must hold, and each failure
   * is a silent, safe degradation to the tap menu:
   *   - a recognizer exists,
   *   - we have a language tag to ask for,
   *   - the locale carries REVIEWED spoken aliases for this language (an
   *     unreviewed language must not get a half-working mic),
   *   - we are online (the Web Speech API is a cloud service in every browser
   *     that ships it — offline it fails, and offline is this app's normal),
   *   - the recognizer has not already refused this language this session.
   */
  function canOffer({ win, lang, aliasMap, online, blocked }) {
    if (!supported(win)) return false;
    if (!recognitionTag(lang)) return false;
    if (!aliasMap || !Object.keys(aliasMap).length) return false;
    if (!online) return false;
    if (blocked) return false;
    return true;
  }

  return { foldGeez, normalize, phraseHit, matchSymptom, LANG_TAGS, recognitionTag, supported, canOffer };
})();
