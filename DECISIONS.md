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

## Open questions for the user (non-blocking — will proceed with defaults)
1. Real registry file: CSV vs XLSX, and the exact column headers, so the
   importer mapping can be finalized.
2. Confirm the placeholder reg-number format vs. the real MoA numbering scheme.
3. Which language should be the demo "one other" alongside Amharic (currently
   assuming Afaan Oromo).
