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
- **Hazard clips**: initially collapsed to 4 levels (`III/U→hazard_low`);
  **superseded by M4.5 Part B**, which restored the 5-level 1:1 mapping — WHO
  `Ia→hazard_extreme, Ib→hazard_high, II→hazard_moderate, III→hazard_low,
  U→hazard_unlikely` (HAZARD_AUDIO in app.js; `hazard_unlikely` was added to
  the recording script v1.1 and the placeholder set). Do not re-collapse U
  into III — "unlikely to be dangerous" and "low danger" are different claims.
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

## Honest language handling (Parts 0.5 + 0.6) — never imply or choose a language

Three locales (`ti`, `so`, `aa`) are English-fallback stubs. Presenting them as
working languages silently sends English — fatal on text-only SMS.

- Each locale carries `complete: true|false` (`am`/`om`/`en` complete). `isComplete()`
  in `localize.js` reads it (`en` always true).
- **We do NOT select a language on the farmer's behalf** (Part 0.6). Language
  choice is politically sensitive in Ethiopia, and Somali/Afar speakers are in
  regions with low Amharic literacy — an auto-fallback fails exactly the users it
  serves. So there is **no default fallback language** (`SMS_FALLBACK` removed).
- **PWA:** an incomplete language stays selectable but, on selection, shows an
  interactive banner **offering both** Amharic and English (buttons), speaks the
  notice **in English**, and applies nothing until the farmer taps a choice. A
  legacy incomplete stored language shows the same offer on load (display stays
  English until they choose).
- **SMS:** `LANG ti|so|aa` replies "<Language> not available yet. Reply LANG AM
  for Amharic or LANG EN for English." and **sets nothing**. Until a choice is
  made, replies use the previously-set language, or **English for a new number**
  (the new-number verdict is English + a neutral `LANG` invite — no silent
  Amharic).
- **Telemetry lives in `events`, never `scans`** (Part 0.6 A). `scans` is the
  safety-audit + surveillance source (M7); putting `LANG_FALLBACK`/help/dose/
  rate-limit rows there corrupted scan counts and per-region counterfeit rates.
  `events(type, channel, payload, region)` now holds all interaction telemetry;
  `scans` holds ONLY real scan verdicts (VERIFIED / UNREGISTERED / EXPIRED /
  BANNED / SUSPENDED / UNCONFIRMED / EMERGENCY, plus the scan-only Tier-2 CONFIRM
  state). A test asserts `scans` contains no other `result_status`. Do not
  overload `scans`.
- Chosen fallbacks are logged to `events` (`type='lang_fallback'`,
  `payload.requested` = the language they asked for, `payload.chosen` = what they
  picked) — real demand data for which language to translate first.
- The **Tigrinya UCS-2** / **Afar GSM-7** reply assertions are `pending` in
  `test-sms.js` — enable when those locales gain strings; replies flip encoding
  and the ≤2-segment fit must be re-verified.

## Resolving CONFIRM rows (Part 0.7) — rates over *resolved* scans only

A Tier-2 `CONFIRM` is a pending state. Left unresolved it inflates the
denominator of any counterfeit rate and throws away a real signal.

- `scans` gains `resolved_status` + `resolved_at` (added via an idempotent
  `ALTER TABLE` migration in `initSchema`, so existing DBs upgrade without a
  reseed). `result_status` stays `CONFIRM`; the answer lives in `resolved_status`.
- `/api/scan` returns the originating `scanId`. `POST /api/scan/confirm
  { scanId, confirm, registrationNo, lang }` resolves it: **YES** →
  `resolved_status` = the `verify.js` verdict (and returns the full record so the
  client reveals dosage/safety); **NO** → `resolved_status = 'REJECTED_BY_USER'`.
  The client now calls this instead of `/api/verify-number` on confirm.
- **`REJECTED_BY_USER` is a counterfeit-suspicion signal, not a null result** —
  the label fuzzy-matched a registered product but the person holding the bottle
  says it isn't that product. `src/stats.js` counts it (with `UNREGISTERED`) in
  the counterfeit-suspicion layer; **M7 surfaces it as its own map layer.**
- **Rates are computed over RESOLVED scans only** (`src/stats.js` `scanStats` is
  the single source). An unresolved `CONFIRM` (farmer walked away) is EXCLUDED
  from `resolvedScans` and every rate — asserted in `test-scan.js`. `EMERGENCY`
  rows are in `scans` but excluded from product-scan rates too (not an
  identification). Resolution is idempotent (a double-answer is a no-op).

## Milestone 6 — genuine offline

### Part A.5 — reachability by outcome, never `navigator.onLine`
`navigator.onLine` reports whether a network interface exists, not whether the
server is reachable — it reads `false` on working links and `true` on dead 2G.
We hit exactly this in the preview (`onLine === false` while every fetch worked),
and getting it wrong flips `UNCONFIRMED ↔ UNREGISTERED`, the most dangerous
verdict, in both directions.

- **`public/js/net.js` is the ONLY module that reads `navigator.onLine`**
  (grep-enforced), and only as a non-authoritative UI *hint*.
- **Online-ness is decided by request OUTCOME**: always attempt with a timeout
  (`config.reachabilityTimeoutMs` / `net.js TIMEOUT_MS`, default 4s). Success
  (even a 4xx/5xx — the server answered) = online; timeout or network error =
  offline. `requestJSON` returns `{ online, ok, data }`.
- **Reconciliation with the brief's rule 1** ("treat `onLine === false` as a hint
  — skip the network attempt, go to cache"): we do NOT skip the attempt, because
  that reintroduces the exact bug (a working link reporting `false`) and would
  fail acceptance test A.5.1 (fetch OK while `onLine === false` → online path).
  We attempt always and decide by outcome. Verified: in the sandbox
  (`onLine === false`) a scan reaches the server and renders its verdict, not the
  offline card.

### Part B — asymmetric registry cache (cache pessimistically)
"Safety expires, danger does not." Offline you cannot tell a fake from a stale
cache, so **counterfeit is an online-only verdict**.

- `GET /api/registry-bundle` (`src/registry.js`) → compact per-product snapshot
  with `checked_at`. Stored in **IndexedDB** (`public/js/registry.js`), not
  localStorage — size + it doesn't block the main thread. On-device size logged
  in dev (~KB for the 20 samples). Fetched in the background on first online load
  (`prepareOffline`), refreshed when older than `refreshAfterDays` (7).
- **The verdict is pure + Node-tested** (`public/js/verdict.js`, run against the
  same file the browser uses via `scripts/test-offline.js`):
  BANNED/SUSPENDED = permanent; registered+expired = EXPIRED (re-evaluated vs the
  device clock); registered+fresh = VERIFIED, spoken "as of <checked_at>", dose
  shown; registered+stale (> `staleAfterDays`, 90) = **STALE** (caution, no dose);
  **no cached record = UNCONFIRMED, NEVER UNREGISTERED**.
- **Merge, don't replace; danger is STICKY** (`mergeBundle`, pure/tested): a
  locally-known BANNED/SUSPENDED reg-no is never un-banned by a sync that omits
  or downgrades it — the anomaly is logged to `events` (`/api/client-event`).
- **Device-clock caveat:** if the clock is before a record's `checked_at`, treat
  it as STALE, not fresh (fail toward caution).
- Cache-age indicator shown when a verdict is served from the cache.
- Verified in preview **with fetch disabled**: BANNED (no dose), unknown →
  UNCONFIRMED, VERIFIED "as of <date>" + dose from cache, STALE → caution/no dose.

### Part A — client-side OCR (the real offline blocker)
M2's Tesseract ran server-side, so scanning needed a network. Moved into the
browser (`public/js/ocr.js`, tesseract.js 5).

- **Assets served from OUR origin, never a CDN** (`public/vendor/tesseract/`, via
  `scripts/vendor-tesseract.sh`) so they are SW-cacheable and work offline. The
  worker/core `.js` loaders are committed; the `.wasm` (~3 MB, one variant is
  actually fetched) and `eng.traineddata.gz` (~2.8 MB) are gitignored (run the
  vendor script after `npm i`). Client download is ~5 MB, not the 10 MB assumed.
- **Absolute URLs are mandatory**: tesseract's blob worker does
  `importScripts(workerPath)`, which rejects a root-relative path
  ("URL invalid"). `ocr.js` builds `new URL('/vendor/tesseract/', location.href)`.
  (Found + fixed live.)
- **Background, non-blocking, resumable-enough**: warm-up runs on first online
  load and NEVER blocks the UI; a spoken + visible "preparing offline mode…"
  chip shows progress. tesseract caches the traineddata in IndexedDB + the SW
  runtime-caches the assets, so once downloaded it is **never re-downloaded**
  ("don't restart from zero on every app open"); a failed warm-up retries next
  open. Byte-range resume of a single interrupted transfer is not implemented
  (the browser/HTTP layer may resume; we rely on the persistent cache instead).
- **Offline there is NO vision-LLM fallback** — a Tier-3 miss with no network is
  `UNCONFIRMED` (conservative), never a dose. This is the correct answer, not a
  degradation. Tier-1/Tier-2 work offline against the cached registry with the
  same dosage-withholding rules; offline CONFIRM resolutions queue for sync (C).
- Verified: tesseract read a clear label **in the browser** ("MANCOZEB 80% WP …
  Reg. No: ETH-FUN-0142/17"); the offline cache renders verdicts with fetch
  disabled (Part B); and the composition (OCR text → matchAnchor → computeVerdict
  → VERIFIED/BANNED/CONFIRM/UNCONFIRMED) is Node-tested (`test-offline.js`).

### Part C — offline scan queue + idempotent sync
- Offline scans (+ offline CONFIRM resolutions) queue in IndexedDB
  (`public/js/queue.js`, a separate `medaguard-queue` DB) with a client-generated
  UUID, geotag (consent-gated, default off), timestamp, verdict, confidence.
- On reachability (net.js), the queue flushes to `POST /api/scans/sync`
  (`src/sync.js`). **Idempotent**: `scans.client_uuid` is UNIQUE + `INSERT OR
  IGNORE`, so a replay adds no duplicate rows. Offline verdicts were provisional,
  so the server **re-verifies** each against the live registry, records the
  authoritative verdict in `synced_status`, and returns "upgrades" where it
  differs. An offline `UNCONFIRMED` that is really `UNREGISTERED`/`BANNED`
  notifies the farmer (red sync banner + spoken).
- **Queue is capped** (`offlineQueueMax`, 200) — oldest dropped; a full queue
  never blocks a new scan (enqueue is fire-and-forget). **Anonymized**: location
  + product read + verdict only; no phone/name/identity.
- Verified: `/api/scans/sync` live over HTTP (UNCONFIRMED→UNREGISTERED upgrade;
  replay → `inserted:0, duplicates:1`) + 12 Node assertions (idempotency,
  upgrades, geotag, anonymity). NOTE: the in-browser queue → reconnect → flush →
  notify walkthrough could not be driven live this session (the preview eval tool
  was unavailable); the server contract it calls is proven live + Node, and the
  client queue is thin IndexedDB + `Net` wiring over those proven primitives.

## Milestone 7 — counterfeit surveillance (regulator view)

This milestone changes the project's risk surface: it turns per-farmer scans into
data a regulator, a manufacturer, and a corrupt distributor would each want to
control. It is built **internal-only, aggregated, gated** from the first commit.

### Part A — aggregation (`src/surveillance.js`)
- Returns **district-level aggregates only**. Raw `lat`/`lon` never appear in any
  output: each scan is bucketed to a named `region`, or its coordinate is snapped
  to a coarse ~0.1° (~11km) grid and only the cell **centroid** is returned,
  labelled `grid_approx`. Original coordinates are dropped.
- **Two floors** gate any counterfeit signal: `≥ minDistrictScans` (10) resolved
  scans AND `≥ minFlagCount` (3) flagged scans. Below either → `insufficient_data`
  (never flagged, never clean). This is the most important safeguard in M7 — a red
  district on one bad scan is defamation.
- `counterfeitRate = (unregistered + banned) / resolved`. `EXPIRED` and
  `REJECTED_BY_USER` are separate counts, **never** in the rate (the latter is
  noisy: OCR errors, not confirmed counterfeits). Reuses `stats.js`
  `effectiveStatus` (resolved-only; unresolved `CONFIRM` excluded).
- Every district carries `sampleSize` + `confidence` (provisional < 30, indicative
  < 100, strong ≥ 100). Date-boxed, default 90 days; `resolveRange` emits
  SQLite-comparable bounds (space-separated, no `Z`) so it doesn't mis-order at day
  boundaries. Optional product breakdown capped at `minProductCount` so one scan
  never names a product. `nationalSummary()` rolls districts up.
- Tested: `test-surveillance.js` (28 assertions) — floors incl. single-scan → not
  flagged and 15-resolved/2-flagged → insufficient (floors are AND), rate excludes
  rejections (0.3333 not 0.5), **no raw coord in output**, grid centroid, confidence
  scaling, date window.

### Part B — access gate (built before the view)
- `requireAdmin` middleware gates every `/api/surveillance/*` endpoint. Token via
  `Authorization: Bearer`, `x-admin-token`, or `?token=`, compared to
  `config.adminToken` (`ADMIN_TOKEN`). **Empty token → LOCKED** (all requests 401,
  loud startup warning). There is no unauthenticated path to the data, not even the
  aggregates. `GET /api/surveillance/districts` + `/summary`. Every access (allow +
  deny) audited to `events` (channel `admin`; path/range/ip, never the token).
- No public route; no route returns raw scan rows. Verified live over HTTP and by
  `test-surveillance-gate.js` (12 assertions, spawns the real server): 401 without/
  wrong token, 200 with valid token (three carriers), payload carries no raw
  coordinate, access audited.

### Part C — the map view (`admin/map.html`, served at gated `/admin/map`)
- Single self-contained admin page (no framework, no external mapping lib — a
  hand-drawn SVG choropleth over Ethiopia's approximate bounding box, so it's
  self-hosted and never blocks on GeoJSON boundary files; district GeoJSON noted
  as a follow-up). Served from `/admin` (a protected path), **never** `/public`.
- **Token gate:** the shell carries NO data. It prompts for the token, validates
  it against `/api/surveillance/summary`, keeps it in `sessionStorage`, and sends
  it as `x-admin-token` on every call. 401 → re-locks. A "Lock" button clears it.
- **Choropleth, not pins:** grid-cell districts drawn as squares at their
  centroid, coloured by `counterfeitRate`. Below-floor districts render in a
  distinct hatched neutral style (never a rate claim). Marker size ∝ sample size
  and provisional districts are faded, so n=3 can't be mistaken for n=300.
- **Layer toggles:** rate · banned sightings · expired sightings · user-rejected
  (the last one captioned "INCLUDES OCR ERRORS, not confirmed counterfeits"). The
  rate layer always neutralises below-floor cells.
- **Date range** defaults to the last 90 days. **Permanent, non-removable
  caption** at the top (patterns not confirmed sales; below-threshold districts
  not assessed). National summary tiles keep the user-rejected count visibly
  OUT of the rate.
- **Export:** `GET /api/surveillance/export` (gated + audited via requireAdmin)
  returns CSV with the caption as header rows and a BLANK rate for below-floor
  districts.
- Verified live in the preview: wrong token rejected + app stays gated; correct
  token loads 8 seeded districts; Bahir Dar (n=35, 2 flags) and Shashamane (n=3)
  both render "insufficient" (floors are AND); 24 user-rejected excluded from the
  17.2% national rate; tooltip shows sample size + confidence; export 401 without
  token / 200 caption-headed CSV with token, access audited. `scripts/
  seed-surveillance.js` is a dev-only demo seeder (not in `npm test`).

## Milestone 7.5 — surveillance poisoning containment (three stacked layers)

The Fable 5 audit's biggest open finding (P5-1): validation alone cannot close
surveillance poisoning. An attacker posts scans bearing made-up registration
numbers at chosen coordinates; the server honestly re-verifies each, honestly
finds them unregistered, and writes legitimate `UNREGISTERED` rows. Every row is
valid; the map still lights up a chosen district. M7.5 makes that a *nuisance*
(a wasted inspector visit), not a *threat* (a false public claim). **Farmer
accounts were deliberately NOT added — anonymity is a privacy choice and stays.**

### Part A — advisory-lead-only, as a hard property (not a caption)
- The containment that matters most: a flagged district can only ever mean "an
  authorized human should look here." Made structural: district `status` is
  `review_recommended` / `insufficient_data`; the rate field is renamed
  `counterfeitRate` → `flaggedReportRate` (a rate of scan *reports*). "This
  location sells fakes" is now unrepresentable in the payload.
- No unauthenticated path exists by construction (all `/api/surveillance/*` +
  export behind `requireAdmin`, grep-confirmed no bypass; `/admin/map` is a
  dataless login shell). Every surveillance response + its 401s carry
  `X-Robots-Tag: noindex` + `Cache-Control: no-store`. New top invariant in
  SAFETY.md + audit list I-13.

### Part B — raise the cost of writing (anonymous, but not free)
- `POST /api/register-device` issues an opaque, HMAC-signed, PII-free write token
  (`src/deviceToken.js`): payload is only `{iat, exp, nonce}`. It is **stateless
  (never stored) and never linked to a scan row**, so it proves the writer went
  through the app once and nothing about who — anonymity preserved, verified by
  test (token absent from the row; payload has no identity keys). Not a farmer
  account. `/api/scans/sync` requires a valid, unexpired token → 401 otherwise.
- Rate limits (reuse the M5 in-memory limiter; **same per-process caveat — move
  to a shared store behind multiple instances**, carried forward for M8): per-
  token budget in *scans* (`syncScansPerHourPerToken`=60), per-IP sync-call cap
  (120), per-IP registration cap (10). Oversized batches are REJECTED (413), not
  truncated (`syncMaxBatch`=200 = `offlineQueueMax`).
- **Farmer-facing paths (verdict, dosage, first-aid, emergency-bundle) are NEVER
  throttled** — limits apply only to the write/register surface (tested: 60
  verdict/scan calls, zero 429s). Client obtains the token on load and
  re-registers + retries once on a 401.
- `DEVICE_TOKEN_SECRET` must be set in production (else a random per-process
  secret is used and tokens don't survive a restart / span instances — a loud
  startup warning fires). Env-documented.

### Part C — quarantine anomalies instead of trusting them live
- A burst of made-up numbers from one source is the fingerprint of poisoning;
  genuine farmer scans don't arrive that way. `src/anomaly.js` (pure, tested)
  runs coarse per-batch heuristics — flag burst (≥`quarantineFlagBurst`=5),
  uniform reg-nos (shared prefix ≥`quarantinePrefixLen`=6), sequential reg-nos,
  and a tight spatial cluster (≤`quarantineClusterSpan`=0.05°) of ≥
  `quarantineUniformMin`=3 flagged scans. **Fail conservative** — any trigger
  quarantines.
- A tripped batch has its FLAGGED scans set to `review_status='pending_review'`
  (new `scans` column; additive migration) and logs `surveillance_quarantine` to
  `events` (reason + count). `surveillance.js` excludes `pending_review` from the
  live aggregate (only `NULL`/`released` count) and surfaces a `pendingReview`
  held-count (admin "Held for review" tile). **Never auto-deletes** — a human
  releases held scans (`review_status='released'` re-admits them). The farmer's
  own upgrade notice is unaffected by quarantine.
- **Scope, by design:** a sync call is one source's burst, and we deliberately
  store no source id on scan rows (anonymity), so cross-batch correlation is out
  of scope — this is a coarse filter, not fraud AI. The Part B per-token/IP rate
  limits already bound per-source volume; the burst heuristic catches the obvious
  attack. A patient attacker drip-feeding distinct non-patterned numbers under
  the rate limit is the residual gap (accepted: it's slow, capped, and still only
  ever produces an inspector lead, never a public claim).

## Milestone 8 — staging deploy (Fly.io + Turso)

**Staging, not a launch.** A real, secure, demonstrable system that is safe by
construction: the production boot-gate refuses to serve unreviewed first-aid, so
the demo runs only via the explicit, banner-showing `STAGING=true` path — never
by flipping data to `reviewed:true`. Remaining pre-pilot inputs are listed in
DEPLOY.md.

### Part B — one fail-closed preflight (`src/preflight.js`)
- "Hardened" = `NODE_ENV=production` OR `STAGING=true`. All fail-closed startup
  conditions are centralized and logged together, then `process.exit(1)` on any
  fatal: cleared-production + unreviewed first-aid; `DEVICE_TOKEN_SECRET`
  missing/weak; `ADMIN_TOKEN`/`AT_WEBHOOK_SECRET` set-but-weak; and it fails
  closed if it can't even verify the review gate. Plain dev only warns.
- The demonstration path is honest: `STAGING=true` may boot with unreviewed data
  but logs "NOT CLEARED FOR FIELD USE" and shows the non-dismissible banner.

### Part C — shared-store rate limiting (`src/rateStore.js`)
- **Choice: a `rate_limits` table in the SAME libSQL DB** (Turso in prod, local
  SQLite in dev) — no new infra. Fixed-window counters keyed by `<prefix>:<key>`,
  incremented via an atomic UPSERT+CASE that resets an expired window in one
  statement, so all Fly machines share one budget. Interface matches the
  in-memory limiter (isLimited/record) but async — call sites just add `await`,
  and an injected in-memory limiter (returning a plain boolean) still works under
  `await`, so the offline tests are unchanged. The in-memory `createRateLimiter`
  is kept for those tests.
- **Fail-open vs fail-closed split:** if the store is unreachable, the SMS
  non-emergency cost-guard (farmer-facing) fails OPEN — never block a verdict or
  emergency — while the write/sync surface fails CLOSED (deny conservatively).
  Verdict/dosage/first-aid/emergency paths are never rate-limited at all;
  emergency SMS still bypasses the limiter entirely; `HELP` still bypasses.
- **TTL cleanup:** expired counter rows are swept once at boot and every 15 min
  (`cleanupRateLimits`, interval `.unref()`ed). `test-ratestore.js` (12) proves
  fixed-window counting, window reset, batch increment, **two instances sharing
  one budget**, the fail-open/closed split, and cleanup.

### Part D — staging posture (undiscoverable, clearly a demo)
- Whole-app `noindex, nofollow` (an app-wide `X-Robots-Tag` middleware on every
  response + a disallow-all `/robots.txt` + `<meta robots>`), so no crawler
  indexes or caches any part of the demo. A **non-dismissible** demonstration
  banner (red bar, no close control, first body child above the topbar) shows
  whenever the server reports `STAGING=true` via the new public `GET
  /api/app-config` (no secrets); cached in localStorage so it shows offline too,
  re-translated on language change (en/am/om; ti/so/aa fall back to English). No
  analytics, trackers, or third-party calls (verified: every request is
  same-origin). SW shell v14.

### Part E — deploy verification (`scripts/test-deploy-config.js`, 21 assertions)
- CI-runnable black-box proof of the production posture: spawns the real server
  across env configs and asserts the boot-gate + preflight FAIL CLOSED (cleared-
  prod+unreviewed, missing `DEVICE_TOKEN_SECRET`, weak `ADMIN_TOKEN` all exit
  non-zero) and that a STAGING build comes up secure (staging flag + M8; robots
  disallow + whole-app noindex; surveillance 401 without / 200 with `ADMIN_TOKEN`
  + noindex/no-store; SMS webhook 401 unauthenticated; verdict path BANNED/
  UNREGISTERED/VERIFIED+dosage against the DB; write surface still device-token
  gated).
- **Fly access was not available this session, so Part E was verified against
  local `NODE_ENV=production` / `STAGING=true` runs** (the exact code the image
  runs) rather than the deployed URL. The image + `fly.toml` + `DEPLOY.md` are in
  place for the actual `fly deploy`.

## Milestone 9 — the homepage (a front door, never a gate)

The app now opens on a welcoming `home` view; the previous opening screen (the
scan orb) is `view-scan`, reached from the hero in one tap.

- **Front-door-not-gate principle:** a farmer with a bottle — or a poisoning —
  never reads or scrolls past anything to act. Above the fold there is exactly
  one hero action ("Scan a bottle", ≥72px), the globally-pinned EMERGENCY button
  (bypasses everything from every view — verified from the homepage
  specifically), the language switcher, and the demonstration banner still
  pinned on top. The story zone (how-it-works / protections / real-conditions /
  how-it-stays-safe / honest footer + repo link) lives below the fold and is
  never required.
- **Returning-visitor logic:** a "skip" control on the homepage sets
  `mg_home_skip` in localStorage → future loads land directly on the scan
  screen (zero taps). Reversible: the same control on the homepage shows a
  ✓-labelled undo that clears the flag. Navigation state and language persist
  across the home↔scan transition.
- **Honest public copy (no borrowed credibility):** the page names NO
  institution, partner, funder or individual (grep-checked: EIAR/GIZ/ministry/
  university/partner/endorse/backed/funded — zero hits in locales + shell); no
  false scale claims ("built for real conditions" frames design intent, not
  deployment); the voice claim was softened ("Get the safe dose…" — voice sits
  under designed-for). The demonstration footer + banner stay. am/om `home.*`
  strings are DRAFT pending native review, same status as the rest of the
  locales; ti/so/aa fall back honestly to English.
- Emoji-tile iconography (zero-asset, matches the app's established icon-first
  design language); no new dependency; homepage is part of the cached shell
  (SW v16) and works offline.

## Milestone 10 — toxicologist sign-off workflow

The SAFETY.md release gate existed (unreviewed first-aid → production boot
refusal) but there was no tool to perform the sign-off. M10 builds the tool and
makes the review **auditable**, without lowering the bar for who may sign off.

### Part A — data model + stricter gate
- `pesticides` gains `reviewed_by` / `reviewer_credential` / `reviewed_at` /
  `review_notes` (idempotent ALTERs). New **append-only** `review_log`
  (id, pesticide_id, action ∈ {approved,revoked,annotated}, reviewer, credential,
  notes, created_at) — `src/review.js` only ever INSERTs; a test greps the source
  to prove no `UPDATE`/`DELETE` against it.
- **"Cleared" is stricter than `reviewed = 1`** (`CLEARED_SQL` = reviewed AND
  reviewed_by AND reviewed_at). The preflight boot-gate counts NOT-cleared
  products against this — a bare `reviewed = 1` (old seed, manual edit) does not
  pass. Revocation is loud: it clears the cleared fields, so the gate re-engages.

### Part B — the gated dashboard (`/admin/review`)
- Same `requireAdmin` + noindex/no-store as the surveillance map; a dataless
  token-gated shell. Progress header + plain gate statement; a reviewer-identity
  bar (name + credential, recorded on every action, set once per session); filter
  tabs (Unreviewed default / Approved / Revoked); a detail view rendering the
  EXACT resolved first-aid steps per route + PPE + hazard + dosages the farmer
  would receive — the reviewer approves the real thing. Approve (optional notes)
  / Revoke (mandatory reason); per-product append-only history; gated review-log
  CSV export. **No bulk-approve endpoint or UI anywhere — the friction is the
  point** (grep-checked).

### Part C — wired to the gate, honestly
- Preflight uses the stricter cleared definition; the staging boot log reports
  "N of M products reviewed" instead of a bare unreviewed count. SAFETY.md
  release-gate section rewritten around the workflow; `test-review.js` (29
  assertions) covers approve/revoke/mandatory-fields/stricter-cleared/append-only
  log/detail resolution/CSV, and resets the DB to 20-unreviewed on exit so
  downstream suites + the demo keep their baseline. `npm test` now 12 suites.

## Milestone 11 — scan quality feedback (attack OCR from the input side)

The biggest untested risk is OCR on real labels — faded, angled, glared, shot
one-handed in sunlight. M11 helps the farmer take a readable photo BEFORE OCR and
makes retry effortless. **All client-side image guidance; it never touches the
verdict, the matcher, or any safety rule. A quality check can only DELAY a scan
for a better photo — never block it** (the "Use anyway" button always proceeds,
and a bad photo still safely resolves to UNCONFIRMED).

- **`public/js/quality.js`** — pure, Node-testable analysis (blur =
  variance-of-Laplacian, exposure = histogram, edgeDensity = adjacent-difference
  strong-gradient fraction, plus `assess()` and the live `lightHint`). Every
  threshold lives in `Quality.DEFAULTS`, **marked PROVISIONAL — to be tuned
  against real Ethiopian label photos** (this pairs with the pending real-photo
  work; the Part C telemetry is exactly the tuning data). Notable tuning choice:
  exposure "bright" is deliberately conservative — real labels are usually
  white/light, so a well-exposed white label must not read as glare.
- **Part A (pre-capture):** a framing reticle with a spoken + written "Fill the
  box" hint, and a live light hint sampling the preview ~2×/sec to a tiny 120px
  canvas (off the preview path — no lag), each hint spoken once, never blocking.
- **Part B (post-capture, before OCR):** on capture/upload, assess a downscaled
  still; pass → OCR with zero friction; fail → a large spoken icon-led suggestion
  naming the ONE biggest problem (blur → exposure → size) with Retake (primary) +
  **Use anyway**. Never runs on the emergency path (no camera there; grep-verified).
- **Part C (retry + transparency):** UNCONFIRMED/low-confidence verdicts gain a
  spoken "Try another photo" + a contextual tip from the failed attempt's
  signals; the CONFIRM card shows the captured photo thumbnail next to what was
  READ (reg-no), so the farmer sees the basis of the match (confirm logic +
  dosage-withholding unchanged); quality signals (blur/exposure/retakes/
  use-anyway/verdict) are logged to **`events`, never `scans`, with no image**
  (anonymized, via `/api/client-event`); loading shows "Reading the label…" then,
  after a long wait, "Checking more carefully…" (vision fallback) — no silent
  spinners.
- Fully localized en/am/om (ti/so/aa honest English fallback); hints spoken via
  the audio layer. `test-quality.js` (19 assertions) tests the pure functions
  incl. a real-world guard that a white label passes. SW shell v14→v18.

## Open questions for the user (non-blocking — will proceed with defaults)
1. Real registry file: CSV vs XLSX, and the exact column headers, so the
   importer mapping can be finalized.
2. Confirm the placeholder reg-number format vs. the real MoA numbering scheme.
3. Which language should be the demo "one other" alongside Amharic (currently
   assuming Afaan Oromo).
