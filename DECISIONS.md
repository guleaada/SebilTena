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
  the acceptance criteria demo). **Tigrinya, Somali, Afar** are
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

## Milestone 3 (offline-first PWA frontend)

### Framework: none (vanilla HTML/CSS/JS)
- No framework, no build step, no bundler. Justification: the target is a
  cracked low-RAM Android on 2G/no signal. Vanilla gives a tiny shell that the
  service worker caches whole and opens instantly offline; there is no runtime,
  hydration or bundle to ship. The app is small enough (~1 HTML + 1 CSS + 1 JS)
  that a framework would add weight and cache churn for no benefit.
- Served by the existing Express app from `public/`; `/locales` is served
  statically so the frontend and the SW reuse the same locale JSON the backend
  uses (no string duplication — reuse per the brief).

### New backend endpoint added for M3
- `GET /api/dosage?pesticideId=&crop=&lang=` (`src/dosage.js`) — pure retrieval
  from the `dosages` table. Returns `{covered:true, dose_per_unit,
  application_notes, pre_harvest_interval_days}` or `{covered:false, message}`
  for an uncovered crop. It NEVER computes/interpolates a dose — uncovered crops
  route to the extension agent. This is retrieval only; it does not touch the
  safety boundary (SAFETY.md). No other backend logic changed.

### UX / design
- Warm, earthy palette (deep field-green, soil-brown, cream) with high-contrast
  amber/red warnings; big rounded shapes; large display weights. Icon-first:
  crops and PPE are large emoji (universal, zero-asset, offline-safe), verdicts
  are a colored badge + symbol + auto-spoken message.
- Color+icon+voice are always paired (never color alone) for glare + literacy.
- Pinned red EMERGENCY (SOS) button, 84px, fixed bottom-left, present on every
  view, one-hand reachable. Emergency *flow* is stubbed (routes to a placeholder
  screen) pending M4.
- All primary/field actions ≥56px (scan orb, capture, crops, verdict buttons,
  SOS); the header language chip is also 56px.

### Voice (Web Speech API) — language gaps
- `speechSynthesis`; a voice is matched by BCP-47 prefix per app language.
  Auto-speak fires the instant a verdict/safety/dose renders; a visible replay
  button is also provided.
- **Graceful fallback:** if no voice matches the selected language we STAY
  SILENT (never garble non-Latin script with a wrong-language voice) while
  keeping text + icon + color. A pluggable server-TTS hook is left for the
  future (the `speak()` seam).
- **Observed voice availability:** in the (headless Chromium) test environment,
  only **English** had a TTS voice; **Amharic, Afaan Oromo, Tigrinya, Somali,
  Afar had none**. On real Android, Amharic (am-ET) is
  sometimes present via Google TTS; the others generally are not. So in practice
  most Ethiopian-language users currently get text+icon+color and rely on the
  future server-TTS provider for audio. This is the single biggest gap to close
  for the voice-first goal — flagged for a server-side TTS integration.

### Language
- Prominent switcher lists all 6 languages in **native script** (from each
  locale's `_native`), persisted in `localStorage` (`mg_lang`); the whole UI
  re-renders and re-speaks on switch. Stub languages (ti/so/aa) still
  select and fall back to English strings (M1/M2 behaviour), pending translation.

### PWA (shell only — deep offline is M6)
- `manifest.json` (standalone, icons 192/512 + maskable, theme colours),
  installable. `sw.js` caches ONLY the app shell (HTML/CSS/JS, all 7 locale
  JSONs, icons) — verified populated in `caches['medaguard-shell-v1']`.
- Registration is done **immediately** in init (not gated on window `load`):
  with a tiny cached shell, `load` can fire before the handler is attached and
  the SW would silently never register. (Caught and fixed during M3 preview.)
- `/api/*` is network-only in the SW; offline it returns a 503 and the app shows
  a spoken "no connection" state. The registry is deliberately NOT cached and
  scans are NOT queued yet — that is M6.

### Verified in preview (mobile viewport, real backend)
- Home, VERIFIED (green ✓ + safety card + crop picker + dose incl. PHI),
  CONFIRM (amber, dosage withheld → YES calls /api/verify-number → reveals),
  UNREGISTERED (red !), BANNED (red ⛔), offline (📡, spoken) — all render with
  correct colour/icon and auto-speak, all farmer-facing text in Amharic.
- Uncovered crop (coffee on Mancozeb) → "not covered, ask agent", no invented
  dose. Language switch persists. SW + shell cache confirmed. Targets ≥56px.

## Milestone 4 Part A (audio layer — pre-recorded clips)

### Why clips instead of TTS
M3 confirmed none of the six Ethiopian languages resolve a Web Speech voice, so
"stay silent" was the only fallback — no channel for a non-reader. Every
safety-critical phrase is from a small fixed set, so we ship **pre-recorded
clips** (recorded once per language by native speakers) instead of synthesising.
Result: perfect pronunciation, full offline, zero API cost, and coverage for
Afar / Tigrinya, which have poor or no commercial TTS coverage.

### Architecture
- **`public/js/audio.js` is the ONLY place that touches `speechSynthesis`.**
  Verified: no `speechSynthesis`/`SpeechSynthesisUtterance` call anywhere else
  (only a comment in app.js). app.js speaks via `AudioLayer.speak(item, lang)` /
  `speakSequence(items, lang)`.
- **Resolution order (logged to `window.__mgAudio` for dev):**
  1. recorded clip `/audio/{lang}/{key}.{fmt}` (primary),
  2. Web Speech TTS if a voice exists (bridge — English/dev mainly),
  3. silent (keep icon + colour + text; never garble, never crash).
  Verified in preview: `en verdict_verified → "clip"`, `am verdict_verified →
  "silent"`.
- An "item" is a phrase-key string or `{ key, text }`; `text` is the TTS-bridge
  fallback for dynamic strings that have no clip (verdict messages, first-aid
  step text) so English dev still speaks them while the six languages await
  recordings.
- **Number composer:** `speakNumber(n, lang, opts)` / `numberItems(n, opts)`
  emit atomic clips — `2.5 → [num_2, point, num_5]`, with dose opts
  `→ [dose_is, num_2, point, num_5, unit_kg_per_hectare]` (matches the spec
  example); integers are atomic `num_0..num_100`, one decimal place. Verified.
- **Manifest** `public/audio/manifest.json` lists which `{lang, key}` clips
  exist; `isAudioAvailable(lang)` reads it (en=true, others=false today). Missing
  languages degrade to icon+colour+text with no error.

### Placeholders & format
- **English placeholder clips are `.m4a` (AAC)**, generated by macOS `say`
  (`scripts/gen-audio-placeholders.js`). No mp3 encoder is available locally
  (no ffmpeg/lame), and browsers play AAC fine. The manifest carries a `format`
  (+ per-language `formats`) field, so the literal `/audio/{lang}/{key}.mp3`
  convention becomes `.{fmt}` — real native-speaker **`.mp3`** recordings drop
  into the same folders and the manifest's format is updated. These English
  clips are DEV PLACEHOLDERS, clearly marked in the manifest `_note`.
- The **six Ethiopian language folders exist but are empty** (`.gitkeep`), ready
  for real recordings. Nothing in the code assumes any language's clips exist.
- Layout note: the frontend lives in `public/` (M3), so these are
  `public/js/audio.js` and `public/audio/` (the M4 brief's `src/public/` is its
  assumed layout; we kept M3's `public/`).

### Service-worker caching (audio)
- Cache bumped to `medaguard-shell-v2`. The SW precaches, for **every available
  language**, the safety-critical clip set (verdict / route / emergency / PPE /
  hazard / dose-is / point / days). Other clips (numbers, the selected
  language's full set) are runtime-cached as they play — lean on low-RAM phones.
  Only `status===200` responses are cached (never a 206 audio range partial).

## Milestone 4 Part B (poison-control emergency flow)

### Retrieval only, no LLM (see SAFETY.md)
- `GET /api/first-aid?activeIngredient=&route=&lang=` and
  `GET /api/emergency-bundle` (`src/firstaid.js`) return only the DB `first_aid`
  column. `source: "db_first_aid"`. Route → column key:
  `skin→skin, eyes→eyes, swallowed→ingestion, breathed→inhalation`.
- Unknown ingredient/route → `found:false`; the UI shows the fixed
  human-reviewed `UNIVERSAL` fallback. Provenance asserted by
  `scripts/test-firstaid.js` (26 checks) — every returned string equals the DB
  value; unknown inputs never fabricate.

### Flow / UX
- One tap from any screen (pinned SOS). `openEmergency()` shows the view and
  renders synchronously — **no network call, no spinner**; the bundle load is
  async and non-blocking (offline uses cache/embedded).
- Route-of-exposure grid: four buttons, **132px** tall (≥72px required — panic
  degrades motor control), big emoji, spoken on focus/hover via `route_*` clips.
- First-aid shown **one step at a time** (DB text split into sentences), large,
  numbered, with a big NEXT; each step auto-plays via `speakSequence` (intro
  clip + step; English via clip/TTS bridge, other languages await recordings).
- Product is optional and never blocking: auto-uses the session scan's active
  ingredient, offers recent scans + a "no product / general first-aid" choice.
- Always-present "Call for help" pulls the regional extension agent + the
  config poison-centre placeholder (`config.poisonCentre`,
  `POISON_CENTRE_NUMBER`).

### Offline
- `GET /api/emergency-bundle` = all seeded ingredients' first_aid + `UNIVERSAL` +
  agents + poison centre. Prefetched at init and stored in **localStorage**
  (primary offline source) and cached by the **service worker** (network-first,
  cache fallback). Verified with the network fully disabled: product first-aid
  loads from the localStorage bundle, and with no cache at all the embedded
  universal fallback still renders. Critical audio clips (emergency/verdict/
  route/PPE/hazard) are SW-precached for every available language.
- Note (first-load race): the init bundle fetch can beat SW activation, so the
  SW may not cache the bundle on the very first load — localStorage covers it,
  and subsequent controlled fetches populate the SW cache too.

### Localization gap
- `UNIVERSAL` first-aid and seeded `first_aid` values are English sample data;
  route labels + emergency chrome are localized (en/am/om drafted). Real
  first-aid text + translations + native audio recordings are pre-deployment
  work (like the rest of the non-English content).

## Audio reconciliation to the canonical recording script

`docs/RECORDING_SCRIPT.md` (supplied by the project owner) is now the **canonical
phrase-key inventory** for the ~80 clips native speakers will record. The M4
placeholder keys were provisional; the app and generator were reconciled so the
returned recordings drop in by exact key. Changes:

- **Renamed audio keys** to canonical: `reading→scanning`, `no_connection→verdict_offline`,
  `wear_this→wear_protection`, `ppe_face_mask→ppe_mask`, `ppe_long_sleeves→ppe_overall`,
  `emergency_choose_route→emergency_ask_route`, `firstaid_intro→emergency_stay_calm`.
- **Hazard clips** now the canonical 4-level set: WHO `Ia→hazard_extreme,
  Ib→hazard_high, II→hazard_moderate, III/U→hazard_low` (mapped in app.js;
  on-screen text still per WHO class from /locales).
- **Verdict clips**: `SUSPENDED` reuses `verdict_banned` (no separate suspended
  clip in the script; both say "do not use").
- **Universal first-aid is now atomic** `aid_*` steps (9 keys) sequenced per
  route (`ROUTE_UNIVERSAL_STEPS`), each with a recorded clip + localized text
  (`aid.*` added to en/am/om) — replaces the free-text `UNIVERSAL` split. This
  makes the offline universal emergency fully voiced by the recordings.
  Product-specific first-aid stays DB free-text (TTS bridge / future per-product
  recordings — the script does not cover per-product first-aid).
- **Number composer** now composes 21–99 from tens+ones (e.g. `45→num_40,num_5`)
  since only `num_0..20` + tens are recorded. Verified: `2.5→num_2,point,num_5`,
  `78→num_70,num_8`, `100→num_100`.
- **Units** aligned to canonical (`unit_ml_per_litre`, `unit_g_per_litre`,
  `unit_kg_per_hectare`, `unit_l_per_hectare`, `unit_ml_per_knapsack`).
- **Nav clips** added (`scan_bottle, yes, no, next, back, try_again, choose_crop`)
  plus `ask_agent, disclaimer, replay` — generated as placeholders for parity;
  wired where natural (disclaimer spoken after the safety card).
- `scripts/gen-audio-placeholders.js` rewritten to emit exactly these 85 keys
  (clears stale keys first); `sw.js` bumped to `v3` and its critical-audio
  precache list updated (verdicts + emergency + route + all `aid_*`).
- Verified in preview: manifest has all 85 canonical keys; the app requests only
  canonical keys (VERIFIED → `verdict_verified, wear_protection, ppe_mask,
  ppe_overall, hazard_low, disclaimer, …`; universal skin → `emergency_stay_calm,
  aid_remove_clothes, …`).

## Milestone 5 (SMS channel — `/api/sms/webhook`)

### Encoding budgets drive the whole reply design (`src/sms/encoding.js`)
- Ethiopic script (Amharic, Tigrinya) forces **UCS-2: 70 chars/
  segment, 67 concatenated**. Latin (Somali, Afaan Oromo, English) gets **GSM-7:
  160/153**. Detection is by content against the real GSM-7 charset + extension
  table, not by language guess.
- **Verdict-first, always.** Every reply leads with the danger word so it
  survives truncation or a dropped segment. Replies are fitted to **≤2 segments**;
  `fitToSegments` trims the *tail*, never the front. Every outbound logs encoding
  + segment count (`[sms:out]`).

### No fuzzy matching over SMS (deliberate)
- SMS accepts **exact registration-number matches only**. The Tier-2 CONFIRM flow
  needs a reliable back-and-forth a panicking/feature-phone farmer may not
  complete, and a wrong confirm is a wrong dose. A non-command, non-reg message
  with no digits → help text; a reg-like unknown → UNREGISTERED (never a dose).

### Session / TTL
- `sms_users` stores the per-phone language preference and a **30-min TTL'd**
  last-VERIFIED product (`SMS_SESSION_TTL_MIN`). `CROP <name>` and emergency
  product-context both require that freshness; otherwise CROP asks for a reg
  number and emergency falls back to `UNIVERSAL_STEPS`. Last product is stored
  only on a VERIFIED result (not banned/expired), so CROP can't dose a bad
  product.

### Emergency by SMS
- `HELP` → route menu; `HELP <route>` or a **bare route word** → first aid
  immediately. Route words recognized in all six languages + English + 1-4
  numeric shortcuts (`src/sms/commands.js`); ti/so/aa words are best-effort
  and need native review (English + numerics always work).
- Steps are `aid_*` **codes** from `firstaid.js` → reviewed `aid.*` strings; no
  prose in the SMS layer. `packEmergency` guarantees `aid_seek_help` + a phone
  number (regional agent + poison centre) in the **first** message, ≤2 messages.
- **Emergency bypasses the rate limiter** — never throttle someone who may be
  dying.

### Abuse / cost / auth
- Rate limit: **in-memory sliding window, 20/hr/phone** (`SMS_RATE_LIMIT_PER_HOUR`).
  In-memory = per-process; behind multiple instances move to a shared store
  (Redis/Turso). Fine for M5 / single instance.
- Inbound is sanitized (control chars stripped) and hard-capped at 160 chars;
  raw inbound is **never echoed** back into a reply.
- Webhook guarded by a shared secret (`AT_WEBHOOK_SECRET`): unauthenticated posts
  → 401. Unset in dev logs an "UNGUARDED" warning. (AT IP allowlist can be added
  at the proxy later.)
- Africa's Talking client is behind `src/sms/client.js` (log-only without creds,
  mockable for tests). 44 offline SMS assertions in `scripts/test-sms.js`.
- SMS templates (`sms.*`) drafted for en/am/om; ti/so/aa fall back to
  English — same DRAFT/native-review caveat as the rest of the locales.

## Language realignment (before M6) — align to SebilAI's actual six

The language set was corrected to match SebilAI (where translations, users and
trust already exist):

- The two lowest-resource languages from the prior set were dropped and **Afar
  (`aa`) added**, to match SebilAI's actual six.
- **English (`en`) promoted to a first-class farmer-facing language**, not a
  dev-only fallback. It is a normal choice in the switcher.
- **Final six:** `am` (Ge'ez/UCS-2), `om` (Latin/GSM-7), `ti` (Ge'ez/UCS-2),
  `so` (Latin/GSM-7), `aa` (Latin/GSM-7), `en` (Latin/GSM-7).
- **SMS encoding:** only `am` and `ti` are UCS-2 (70/67); `om`/`so`/`aa`/`en` are
  GSM-7 (160/153). `encoding.js` detects by content, so this "just works"; tests
  updated (Afar GSM-7 assertion added, the dropped languages' cases removed).
- **Audio / recordings:** five recording languages — `am, om, ti, so, aa`.
  **English needs NO recordings** — it legitimately resolves via the Web Speech
  TTS bridge (clip → TTS → silent order unchanged). `aa` ships as a stub locale +
  empty `public/audio/aa/` folder; missing clips degrade to icon + colour + text.
- `aa` is DRAFT (falls back to English) like `ti`/`so`; Afar route words for SMS
  are best-effort pending native review (English + numeric `1–4` always work).
- No phrase key, filename, or folder-per-language convention changed.

## Open questions for the user (non-blocking — will proceed with defaults)
1. Real registry file: CSV vs XLSX, and the exact column headers, so the
   importer mapping can be finalized.
2. Confirm the placeholder reg-number format vs. the real MoA numbering scheme.
3. Which language should be the demo "one other" alongside Amharic (currently
   assuming Afaan Oromo).
