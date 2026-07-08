# DECISIONS.md — MedaGuard build decisions

Running log of reasonable choices made without blocking on the user, per the
build brief ("make reasonable choices and record them"). Each is revisable.

## Milestone 1 (Express + DB + schema + seed + `/api/verify-number`)

### Stack
- **Runtime:** Node.js (tested on v24) + Express 4. ES modules (`"type":
  "module"`) for clean imports; matches a modern SebilAI-style codebase.
- **DB client:** `@libsql/client`. Same client talks to Turso (remote) in prod
  and a local SQLite file in dev. Selection is env-driven: if
  `TURSO_DATABASE_URL` is set → Turso; otherwise → `file:./medaguard.db`. No code
  changes needed to switch. (`src/db.js`, `dbMode` reports which.)
- **No heavy deps in M1.** CSV parsing for the registry importer is a small
  hand-written RFC-4180-ish parser (`scripts/seed.js`) rather than pulling in a
  library. Revisit if the real MoA file has awkward encodings.

### Architecture
- **`src/verify.js` is the single retrieval core.** `/api/verify-number` (M1),
  the SMS webhook (M5), and offline mode (M6) all call it. Keeping one code path
  means the retriever-not-adviser boundary (`SAFETY.md`) is enforced in one
  place.
- **Status logic** (`deriveStatus`): `banned` → BANNED; `suspended` →
  SUSPENDED; registered-but-past-`expiry_date` → EXPIRED; else VERIFIED. No
  match in registry → UNREGISTERED (possible counterfeit). Empty/garbled input →
  UNCONFIRMED (conservative default).
- **Confidence for `verify-number` is `high`** on any exact registry hit or
  definitive miss, because it's a deterministic lookup, not a vision read. The
  `low/medium` confidence path becomes meaningful in M2 when Tesseract/vision
  enters the pipeline.
- **Banned/suspended results deliberately omit dosage & PPE usage details** —
  the response carries only the loud warning. Showing "how to use" a banned
  product would undercut the warning.
- **Expired results** return the product identity + safety record but **no
  dosages** — the message is "don't use, ask a human," not "here's how much."
- **`warningLevel`** (`safe` | `warning` | `danger`) and **`speak`** flags are
  in the API response so the M3 frontend can drive red UI + voice without
  re-deriving severity.

### Data
- **Reg-number format is a placeholder:** `ETH-<TYPE>-<SEQ>/<YY>` (FUN/INS/HRB).
  The real MoA Plant Health Regulatory Directorate numbers replace these at seed
  time. Flagged in `data/sample_pesticides.json._meta`.
- **20 sample products** shipped (brief asked for 15–20) so the full pipeline is
  demoable today: 13 registered, 4 banned (Endosulfan, DDT, Methyl parathion,
  Carbofuran), 2 suspended (Chlorpyrifos, Paraquat), 1 expired (Dimethoate).
- **Sample first-aid / PPE / dosage strings are ILLUSTRATIVE placeholders**, not
  authoritative label data. They exist to exercise the pipeline and MUST be
  replaced by the official registry + label data before any real use. Flagged in
  the data file and `SAFETY.md`.
- **Seed script is idempotent** for the ground-truth tables: it resets
  `pesticides`, `dosages`, `extension_agents` and re-inserts, but never touches
  the `scans` audit log. If `data/registered_pesticides.csv` exists it is
  ingested (flexible header mapping); otherwise the sample JSON is used. XLSX is
  not yet parsed — export to CSV (noted to the user at runtime).

### Localization
- All farmer-facing strings live in `/locales/*.json` (nested `status` / `msg` /
  `disclaimer` keys). `t(lang, key)` falls back to English per-key.
- **English + Amharic + Afaan Oromo** are drafted (the two non-English languages
  the acceptance criteria demo). **Tigrinya, Somali, Sidaamu Afoo, Wolaytta** are
  present as stubs that fall back to English — full translation happens in M3.
- **All non-English strings are marked DRAFT/STUB and require native-speaker +
  agronomist review before deployment.** Machine translation of the *dangerous
  DB fields* is explicitly disallowed (`SAFETY.md`).

### Deferred to later milestones (not gaps in M1)
- Vision/Tesseract pipeline & `aiClient` fallback chain → M2.
- `/api/scan`, `/api/dosage`, `/api/first-aid`, SMS webhook, admin map → M2–M7.
- PWA frontend, service worker, offline registry subset, voice → M3/M6.
- `fly.toml` + `Dockerfile` → M8.

## Milestone 2 (scan pipeline — `aiClient` + `/api/scan`)

### The design change vs. the original spec (per M2 brief)
- **Anchor is format-agnostic and multi-field**, not a reg-no regex. `matchAnchor`
  (`src/match.js`) matches label tokens/lines against the registry across three
  columns — `registration_no`, `product_name`, `active_ingredient`. Works on real
  Ethiopian labels whatever their numbering scheme, and survives smudged/missing
  reg numbers. A miss across all three is the counterfeit signal.

### Thresholds & tunables (all in `src/config.js`, env-overridable)
- **`fuzzyThreshold = 0.82`** (`MATCH_FUZZY_THRESHOLD`) — Tier-2 acceptance on
  character-bigram Dice similarity. Starting value per brief; tune against real
  label photos.
- **`regNoMinLen = 5`** — minimum normalized reg-no length for a Tier-1 exact
  substring hit (guards trivial false positives).
- **`ocrMinConfidence = 55`** — Tesseract confidence (0–100) treated as usable.
  Note: escalation to vision is driven by a Tier-3 *miss*, not raw OCR confidence,
  since a Tier-1/Tier-2 hit is reliable even from noisy OCR.
- **`aiTimeoutMs = 12000`** per-provider vision timeout.
- **`visionAcceptConfidence = ['high','medium']`** — a provider returning `low`
  falls through to the next, then to the conservative default.

### Provider models (config.models, env-overridable — exact IDs NOT load-bearing)
- Groq: `meta-llama/llama-4-scout-17b-16e-instruct` (`GROQ_VISION_MODEL`)
- OpenRouter: `google/gemini-2.0-flash-001` (`OPENROUTER_VISION_MODEL`)
- Gemini: `gemini-2.0-flash` (`GEMINI_VISION_MODEL`)
- Order Groq → OpenRouter → Gemini; skip any provider whose API key is unset.
  With no keys (dev default) the chain returns `confidence:'low'` and the caller
  applies the conservative default — no crash.

### Matching internals
- **Similarity = character-bigram Dice coefficient** (`similarity()`), dependency-
  free, order-forgiving, tolerant of OCR noise. Chosen over Levenshtein for word-
  order robustness on multi-word product names.
- **Tier-1 matches against a normalized blob** of the whole read, so OCR splitting
  a number into separate tokens ("ETH","FUN","0142","17") still resolves.
- `extractRegCandidate()` logs a best-effort "what number did we read" (longest
  alphanumeric token containing a digit) — never used for a matching decision.

### Endpoint & reuse
- `/api/scan` reuses `verify.js` verbatim for the VERIFIED payload — no dosage/
  safety logic duplicated. `runScan` is dependency-injectable (`ocr`, `readLabel`,
  `verifyNumber`, `db`) so the whole flow is tested without network/keys
  (`scripts/test-scan.js`, 41 assertions, `npm run test:scan`).
- **CONFIRM handoff:** on a Tier-2 fuzzy match the response returns
  `needsConfirmation:true` + `confirmRegistrationNo`; the client reveals dosage
  only by then calling the existing `POST /api/verify-number` with that number.
  Dosage/PPE/first-aid are withheld until then.
- **OCR is server-side here** (M2 API path) and resilient — any Tesseract failure
  returns empty text so the flow degrades to vision/conservative, never throws. In
  M3 the same OCR runs client-side for offline use.

### Verified end-to-end (real server-side Tesseract, synthetic labels)
- Clear Mancozeb label → VERIFIED via Tier-1 **without any vision call**, dosages
  from DB, headline in Amharic, geotagged scan row written.
- Malathion label with reg-no worn off → CONFIRM (Tier-2), dosage withheld.
- Unknown "Super Grow Booster" label, no vision keys → conservative UNCONFIRMED.

## Open questions for the user (non-blocking — will proceed with defaults)
1. Real registry file: CSV vs XLSX, and the exact column headers, so the
   importer mapping can be finalized.
2. Confirm the placeholder reg-number format vs. the real MoA numbering scheme.
3. Which language should be the demo "one other" alongside Amharic (currently
   assuming Afaan Oromo).
