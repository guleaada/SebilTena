# MedaGuard — Full-Codebase Safety Audit

**Date:** 2026-07-11 · **Auditor:** Claude (Fable 5), acting as senior safety auditor
**Scope:** entire repository at commit `7e6e303` (M1–M7 complete; M8 not started — no `fly.toml`/`Dockerfile` exists yet, so the deploy config named in the audit brief could not be reviewed)
**Method:** full read of every source file, test, locale, governance doc, recording script, manifest and seed datum **before** any conclusion; every invariant then verified by tracing the code path, grepping for violations, and — where the invariant guards a wire boundary — **proving the gap dynamically** before grading it.
**Law:** `SAFETY.md` + `DECISIONS.md`. No safety rule was weakened, relaxed or removed by this audit.

---

## 1. The reconstructed safety doctrine

The invariants the code claims to uphold, as reconstructed from SAFETY.md, DECISIONS.md, and the code itself:

| # | Invariant |
|---|-----------|
| I-1 | **Retriever-not-adviser:** no dosage / first-aid / PPE / PHI / hazard / registration-status value ever originates from an LLM or OCR — every one traces to a DB row. The vision chain may only produce four identity fields. |
| I-2 | **Tier-2 fuzzy match = CONFIRM:** dosage, PPE and first-aid withheld until the farmer confirms; a fuzzy match is a hypothesis, never a licence. |
| I-3 | **Emergency is pure retrieval:** no LLM in the path, controlled `aid_*` vocabulary only, no prose on the wire, one renderer, works fully offline. |
| I-4 | **Cache pessimistically:** BANNED/SUSPENDED permanent + sticky across syncs (anomaly → events); VERIFIED carries `checked_at`, spoken "as of", decays to STALE (caution, no dose); wrong/backdated clock → stale. |
| I-5 | **Offline cannot prove counterfeit:** an unknown reg-no offline is UNCONFIRMED, never UNREGISTERED. |
| I-6 | **Reachability by outcome:** `navigator.onLine` read only in `public/js/net.js`, never branches a verdict. |
| I-7 | **SMS fails toward help, never toward a menu:** a message containing HELP gets first aid + phone numbers first, menu after; emergency never rate-limits, never gates on a product. |
| I-8 | **Surveillance restraint:** district-level only, no raw coordinates leave the server, two floors before any flag, `REJECTED_BY_USER` never in the counterfeit rate, every endpoint gated + audited, sample size + confidence on every figure. |
| I-9 | **`scans` is verdicts-only:** telemetry lives in `events`; only the fixed verdict vocabulary may appear in `result_status`. |
| I-10 | **CONFIRM rows get resolved; rates over resolved scans only.** |
| I-11 | **Release gate:** all first-aid data `reviewed:false` until toxicologist sign-off; loud startup warning; production must refuse to start while it fires. |
| I-12 | **Honest language handling:** never present an incomplete language as working; never choose a fallback for the farmer; SMS verdict-first within segment budgets. |
| I-13 | **Surveillance is advisory-lead-only (M7.5):** output is an investigative lead for authorized regulators, never a public or factual claim about a location. No unauthenticated path exists by construction (gate + noindex/no-store, dataless map shell); districts are typed `review_recommended`/`insufficient_data` with a `flaggedReportRate` (report rate, not a location property) — "this location sells fakes" is unrepresentable. Writes are token-gated + rate-limited; anomalous bursts are quarantined out of the live aggregate. Posture is architectural; must not be weakened. |

---

## 2. Part 1 — invariant verification (evidence, not assertion)

Grades reflect the codebase **as found** at `7e6e303`; "→ FIXED" marks gaps closed by this audit's Part-4 commits.

### I-1 Retriever-not-adviser — **PASS**
- `src/verify.js` (whole file) is pure DB lookup; `deriveStatus()` (verify.js:40) is pure DB logic; banned/suspended return `safety:null, dosages:[]` (verify.js:146-148); expired returns no dosages (verify.js:158-159).
- `lib/aiClient.js:38-47` — `sanitize()` keeps ONLY the four identity keys; anything else a model volunteers is dropped. `VISION_PROMPT` (aiClient.js:15-21) forbids inference, asserted by test (`test-scan.js:198`).
- `src/dosage.js:27-37` — uncovered crop → `covered:false`, never computes/interpolates.
- `src/firstaid.js` — codes only, `provenance:"db_controlled_vocab"`.
- Only writers of `pesticides`/`dosages` in the entire repo: `scripts/seed.js:102,127` (grep-proven), and `seed.js:97-99` rejects out-of-vocabulary first-aid loudly on both the JSON and CSV paths.
- Client: offline dose comes from the cached DB record (`app.js:689-693`), offline safety from `offlineVerifyToResult` — no generation anywhere.

### I-2 Tier-2 CONFIRM withholds dosage — **PASS**
- Online: `scan.js:149-177` returns identity only ("Identity only — NO dosage/safety until the farmer confirms"); `test-scan.js` T2 asserts the *absence* (`res.verify === undefined`, `res.dosages === undefined`) — a strong test.
- Offline: `public/js/registry.js:118-122` returns `needsConfirmation` with no verdict/record payload beyond identity; dose revealed only after YES → `computeVerdict` (`app.js:585-599`).
- Resolution (Part 0.7): `scan.js:206-213` transitions only a still-pending CONFIRM (idempotent, tested incl. double-answer).

### I-3 Emergency purity — **PASS**
- No LLM import anywhere near `src/firstaid.js` / the emergency flow; steps are codes (`stepsForRoute`, aidCodes.js:71-75), never blank for a known route, `UNIVERSAL_STEPS` fallback is a constant.
- `test-firstaid.js:35-53` audits the **DB itself** for prose/invalid routes/out-of-vocab codes — this checks the data, not just the API.
- SMS: steps = codes → reviewed `aid.*` strings (`handler.js:199-201`); `packEmergency` guarantees `aid_seek_help` + phone in message 1 (templates.js:73-92, tested).
- Offline: `app.js:883-884` — bundle → localStorage → embedded `ROUTE_UNIVERSAL_STEPS` constant; opens with no network call (`openEmergency`, app.js:918-927).

### I-4 Asymmetric cache, sticky danger — **PASS**
- `public/js/verdict.js:50-51` — banned/suspended permanent, no staleness/clock/downgrade path; `:63-65` — stale or clock-suspect → STALE, no dose; `:60` — missing/later `checked_at` → suspect (fail toward caution).
- `mergeBundle` (verdict.js:82-108) — downgrade kept banned + `sticky_ban_kept` anomaly; omission kept + `sticky_ban_orphan_kept`; `registry.js:99-101` beacons anomalies to `/api/client-event` → `events`.
- 28 Node assertions run **the same file the browser executes** (`test-offline.js:24-25`).
- Checked for the reverse hole: `saveBundle` only upserts (never deletes), so merge-not-replace holds for non-danger records too.

### I-5 Offline unknown = UNCONFIRMED, never UNREGISTERED — **PASS client-side; was WEAK at the sync boundary → FIXED (`979da76`)**
- Client: `verdict.js:42-45`, `registry.js:114-116`; grep shows no client-side UNREGISTERED emission; tested.
- **Proven gap (pre-fix):** `POST /api/scans/sync` accepted `result_status:"UNREGISTERED"` from the unauthenticated wire and wrote it into `scans` — the exact verdict offline cannot prove, and the surveillance-poisoning vector (paint a district by claiming counterfeits). Live demo wrote it verbatim. Now clamped: UNREGISTERED/STALE/garbage → UNCONFIRMED; the server's own re-verify records the authoritative verdict in `synced_status` (tested).

### I-6 Reachability by outcome — **PASS**
- Grep: `navigator.onLine` appears in `public/js/net.js` only; `onlineHint()` is exported but **no module calls it** — nothing branches on the flag anywhere.
- `net.js:28-39` — always attempt, 4s timeout, outcome decides; 4xx/5xx = online (correct: server answered).
- Verified live in M6 (the sandbox exhibits `onLine===false` with a working link; scans still reached the server).
- Hardened this audit: the "grep-enforced" rule is now **test-enforced** (`test-offline.js`, commit `276caaf`).

### I-7 SMS fails toward help — **was WEAK → FIXED for English (`90ca673`); "any language" half remains open by design**
- Held: HELP+unparseable route → route-agnostic aid + numbers first, menu after (`handler.js:214-225`); emergency bypasses the rate limiter (`handler.js:96,103`); never gates on a product; `aid_seek_help`+phone guaranteed in message 1.
- **Proven gap (pre-fix):** SAFETY.md says "if a message **contains** HELP"; the code required HELP as the **first word**. "I NEED HELP" / "PLEASE HELP ME" → UNKNOWN → a commands menu. Panicking people don't type command syntax. Fixed: whole-word HELP anywhere in an otherwise-unparseable message → emergency (bypasses limiter); both HELP branches now scan every word for a route ("MY SON SWALLOWED IT HELP" → swallowed-specific aid). Command precedence unchanged (tested).
- **Still open (Part 5):** localized help-word synonyms ("any language"). Not invented here — safety vocabulary requires native review. Localized bare *route* words already work in all six languages.

### I-8 Surveillance restraint — **PASS**, two conservative-direction caveats (Part 5)
- No raw coordinates: `bucketOf` (surveillance.js) returns named region or grid **centroid** only; proven dynamically (three distinct raw points collapse to one centroid; raw values absent from serialized output) and black-box through the real server (`test-surveillance-gate.js`).
- Floors are AND (single-scan district and 15-resolved/2-flagged district both `insufficient_data` — tested); `REJECTED_BY_USER` never in the rate (arithmetic tested: 0.3333, not 0.5); every endpoint behind `requireAdmin` (empty token = locked); access audited both ways; sample size + confidence on every district; export caption-headed with blank rates below floor; map caption non-removable.
- Caveat A: aggregation reads the **provisional** `result_status` and ignores the authoritative `synced_status` — a synced offline UNCONFIRMED that re-verified UNREGISTERED is counted as UNCONFIRMED (proven dynamically). Undercounts counterfeits — conservative, but the better data exists and is ignored → P5-2.
- Caveat B: the data source itself accepts unauthenticated writes (see Part 2 finding F-2).

### I-9 `scans` verdicts-only — **was FAIL at the sync boundary → FIXED (`979da76`)**
- Internal writers clean: `scan.js` logs pipeline verdicts; `sms/handler.js` logs verdicts + EMERGENCY; telemetry goes through `logEvent` → `events` (grep of all `INSERT INTO scans` call sites).
- **Proven FAIL (pre-fix):** `syncScans` wrote any client-supplied string into `result_status` (`"LANG_FALLBACK_GARBAGE"` accepted verbatim, live), plus `STALE` (a real offline UI state not in the vocabulary — silently invisible to every rate), plus type garbage (an *object* in `lat` threw at bind time → 500 → **the client queue wedged in an infinite retry**), plus ISO `created_at` strings that mis-sort against SQLite's space-format window bounds (a same-day row proven to fall outside its window). All fixed with whitelists, type/range clamps, date normalization, per-item isolation, and a batch cap; 14 new boundary assertions.

### I-10 CONFIRM resolution, resolved-only rates — **PASS**, one visibility caveat
- `stats.js` is the single rate source; unresolved CONFIRM excluded (tested); resolution idempotent (tested); EMERGENCY excluded from product rates.
- Caveat: an **offline** YES-confirm syncs as `resolved_status:"CONFIRMED_BY_USER"`, which is not in `PRODUCT_VERDICTS` — the row is invisible to every rate (proven: `resolvedScans:0`). Conservative direction (undercount), but it silently discards a real resolution → P5-2.

### I-11 Release gate — **was WEAK → FIXED (`58f840c`)**
- Held: all 20 seeded products `reviewed:false` (verified in data + asserted by test); loud startup banner; bundle carries `reviewed:false`.
- **Gap (pre-fix):** SAFETY.md — "Production deploys must refuse to start … while that warning fires." The server warned and started anyway. Now: `NODE_ENV=production` + unreviewed data → `process.exit(1)`, and the gate **fails closed** if the check itself errors in production. No override env var exists, by design. Verified: production exits 1; dev unchanged.

### I-12 Honest language handling — **PASS**
- `isComplete()` (localize.js:50-55); PWA offers both am/en and applies nothing until tapped (app.js:199-244); stored-incomplete language displays English + the offer on load (app.js:969-974); SMS `LANG ti|so|aa` sets nothing and offers both (handler.js:120-128, tested incl. "sets NOTHING" DB assertion); new numbers get English + LANG invite, never silent Amharic (tested); telemetry → events (tested).
- Note (not a violation): the PWA's *first-boot* default is `am` (app.js:71) — a visible product choice with a prominent switcher, unlike the silent-SMS case the rule targets. Flagged for awareness only.

**Hunt-list sweep results:** no LLM/OCR output reaches a safety field (I-1); no offline UNREGISTERED emission client-side, wire path fixed (I-5/I-9); no surveillance response carries row-level lat/lon (dynamic + black-box proof); no stray `navigator.onLine` reader (now test-enforced); no telemetry writes into `scans` from app/SMS code, wire path fixed; no partial sync can clear a BANNED flag (sticky-merge tested both directions); no emergency path returns a bare menu when HELP is present — after fix 2, including mid-message HELP.

---

## 3. Part 2 — security / correctness / quality findings (ranked)

| # | Sev | Status | Finding |
|---|-----|--------|---------|
| F-1 | **High** | **FIXED** `979da76` | Unauthenticated sync input written verbatim into the safety-audit/surveillance table: non-verdict statuses, wire-claimed UNREGISTERED, type garbage that 500-wedged the client queue, window-breaking date formats. (Details under I-9.) |
| F-2 | **High** | **OPEN → P5-1** | The surveillance data source accepts **unauthenticated, unrate-limited writes**. Even with F-1 fixed, an attacker can script `POST /api/scan` with garbage images + chosen coordinates: each call yields an honest server-derived UNREGISTERED row at a location the attacker picked. The two floors force volume (≥3 flagged, ≥10 resolved per district) but do not stop a script. No IP/device rate limit exists on `/api/scan` or `/api/scans/sync`. This is the biggest open risk in the codebase. |
| F-3 | **Med** | **FIXED** `58f840c` | Release gate warned but did not refuse in production (SAFETY.md requires refusal). |
| F-4 | **Med** | **OPEN → P5-2** | Surveillance ignores `synced_status` (authoritative re-verified verdict) and counts the provisional offline verdict; offline `CONFIRMED_BY_USER` resolutions are invisible to every rate. Both errors point the *conservative* direction (undercount counterfeits), but they discard the best available data. Fixing changes rate arithmetic → proposal, not a unilateral fix. |
| F-5 | **Med** | **FIXED** `a5b3c0d` | `===` secret comparison on both `ADMIN_TOKEN` and the SMS webhook secret (timing side-channel). Now sha256 + `timingSafeEqual`. |
| F-6 | **Med** | **OPEN → P5-3** | Secrets accepted in **query strings** (`?token=`, `?secret=`) — these leak into server/proxy logs and browser history. The map UI already uses the header; AT webhook config may rely on `?secret=`. Removing a carrier is a behavior change → proposal. |
| F-7 | **Low** | **OPEN → P5-4** | Client queue race: `Queue.flush()` snapshots items, POSTs, then deletes by uuid. An offline CONFIRM answered between snapshot and delete is silently lost (scan stays unresolved server-side — excluded from rates, so conservative, but data loss). |
| F-8 | **Low** | **OPEN → P5-5** | `msg.sync_danger` text (and the `verdict_unregistered` clip) say "is NOT registered" even when the sync upgrade is **BANNED** — "do not use it" is still conveyed, but the reason is imprecise. Fix needs new reviewed strings in en/am/om + a clip switch — cannot be authored by an auditor. `showSyncNotice` also silently drops its second argument (the status intended to drive this). |
| F-9 | **Low** | **OPEN → P5-6** | Unauthenticated `surveillance_denied` audits let anyone flood `events`; `express.json({limit:"12mb"})` applies to every POST (a 12 MB body to `/api/scans/sync` is accepted); no per-route body caps. |
| F-10 | **Low** | OPEN (documented) | SMS rate limiter is in-memory per-process — already flagged in DECISIONS.md; must move to a shared store before multi-instance deploy (M8). |
| F-11 | **Low** | OPEN | `/api/scan` server 4xx/5xx renders the "No connection" card (`runScan` → `renderOffline`) — misleading copy for a reachable-but-erroring server; conservative outcome, wrong words. |
| F-12 | **Info** | OPEN | `sms_users.region` is never written, so `getAgent(region)` always falls back to the first agent — dead field until region capture exists. |
| F-13 | **Info** | OPEN | Minor: SW runtime-caches `/admin/map` HTML into the farmer-device cache after an admin visit (shell only, carries no data); `.DS_Store` files served by `express.static` (harmless, gitignored); a corrupt locale JSON would throw inside `t()` → 500. |
| F-14 | **Info** | — | Supply chain: 4 direct deps (`@libsql/client`, `dotenv`, `express`, `tesseract.js`), 110 locked, `npm audit`: **0 vulnerabilities**. Tesseract assets vendored from our origin (no CDN). No `fly.toml` yet — M8 must wire the release gate into CI/deploy. |

**PWA integrity checks performed:** SW cache-first shell + network-only APIs + network-first-with-fallback emergency bundle all correct; only full 200 responses cached (no 206 partials); SW registered immediately (not on `load`); traineddata persistence via tesseract IndexedDB `cacheMethod:"write"` + SW runtime cache — re-download avoided; byte-range resume of a single interrupted transfer is not implemented (documented honestly in DECISIONS.md); cache version `v12` consistent with history; queue/registry in separate IndexedDB databases (version-coordination hazard avoided); `Queue.enqueue` spread order safe for all real call sites.

**DECISIONS.md consistency sweep:** one genuine contradiction found and fixed (4-level vs 5-level hazard clips → `1bb0e9b`); README was three milestones stale → fixed; `/api/health` reported "M3" → fixed. Historical counts inside milestone log entries (e.g. "44 SMS assertions" at M5 time) were left as history. Remaining claims verified accurate, including the M6 confession that the in-browser queue walkthrough wasn't driven live at M6 time (it was later driven live pre-M7: flush → 0, red banner shown).

---

## 4. Part 3 — test integrity

**Would the test still pass if the rule broke? Mostly no — the safety tests are largely real:**
- Dosage-withholding asserts **absence** (`res.verify === undefined`), not just shape.
- The first-aid vocabulary guard audits **the DB rows themselves** for prose/invalid codes, not just API output.
- The offline verdict tests execute **the same file the browser runs** (`new Function(window)`) — no parallel reimplementation to drift.
- The gate test **spawns the real server** and checks 401/200/no-coordinate-leak/audit black-box.
- The floors test the defining cases (single-scan district; many-scans-few-flags), and the REJECTED_BY_USER rule tests the **arithmetic** (0.3333 vs 0.5), not the field's presence.
- The SMS layer has a source-scan test proving no safety prose is defined in `src/sms/*`.

**Theatre found:**
1. **The scans-purity test only audited its own writes** (`test-sms.js:321-327` checks `DISTINCT result_status` in a DB the test itself populated). The sync wire path could violate the invariant without any test noticing — and demonstrably did (F-1). Now enforced at the boundary itself + 14 boundary assertions (`979da76`).
2. **"Grep-enforced" was human-enforced.** No test ran the navigator.onLine/speechSynthesis greps. Now a real test (`276caaf`).
3. Residual (accepted, flagged): the no-raw-coordinate tests assert the *specific seeded values* are absent from output — a coordinate that happened to equal a centroid would false-pass (kept: centroid values are grid-snapped, collision is contrived); the SMS prose-leak regex is a finite phrase list — a tripwire, not a proof.

**Pending tests (2):** Tigrinya UCS-2 reply and Afar GSM-7 reply assertions in `test-sms.js` — correctly `pending`, with explicit enabling conditions (locale `complete:true` + re-verify ≤2-segment fit). These must be enabled before those languages ship.

**Synthetic-only coverage — the real-world gaps, stated plainly:**
- **No test has ever seen a photograph.** All OCR/vision tests use `ocrTextOverride` or synthetic strings; the live checks used rendered labels. Field phones, curved bottles, glare, torn labels, Amharic-script labels: unvalidated. `fuzzyThreshold: 0.82` is untuned against real Ethiopian labels — the single most safety-sensitive tunable in the match path.
- Registry data is invented sample data (20 products); the real MoA list (~1,011 products) will change Tier-2 fuzzy-collision behavior in unknown ways (more products = more near-neighbours at 0.82).
- All first-aid content + `UNIVERSAL_STEPS` are unreviewed placeholders (release-gated).
- Audio clips are macOS-`say` English placeholders; the five recording languages have zero clips; voice-first is currently text-first for every Ethiopian-language user.
- IndexedDB code paths: pure logic Node-tested; the browser IO paths verified manually in the preview, not in CI.
- No load/concurrency testing anywhere (relevant to F-2/F-9 and the in-memory rate limiter).

---

## 5. Part 4 — fixes applied (all restrained, none weaken a rule)

| Commit | Fix | Category |
|--------|-----|----------|
| `979da76` | Sync/scan wire-input validation: verdicts-only vocabulary enforced at the boundary (UNREGISTERED/STALE/garbage → UNCONFIRMED; authoritative verdict still recorded in `synced_status`), coordinate type/range clamps at both trust boundaries, `created_at` normalization to SQLite window format, per-item poison isolation (no more queue-wedging 500s), batch cap, `rejected` count; +14 assertions | Genuine bug / code-matches-documented-contract |
| `90ca673` | A message **containing** HELP fails toward help (SAFETY.md's own words); route words recognized anywhere in the message; emergency bypass preserved; precedence unchanged; +6 assertions | Code-matches-documented-intent |
| `a5b3c0d` | Constant-time comparison for `ADMIN_TOKEN` + SMS webhook secret | Hardening bug fix, zero behavior change |
| `58f840c` | Release gate **refuses to start** in production with unreviewed first-aid data, and fails closed if the check errors (SAFETY.md's exact requirement); dev unchanged | Code-matches-documented-intent |
| `1bb0e9b` | Doc drift: README status (M1–M7 + release-gate note), `/api/health` milestone string, DECISIONS.md stale 4-level hazard paragraph | Doc/code drift |
| `276caaf` | The "grep-enforced" single-module rules (navigator.onLine, speechSynthesis) are now test-enforced | Invariant-hardening test |

Suite after all fixes: **7/7 green — 52 + 38 + 74 + 28 + 26 + 28 + 12 = 258 passing, 2 pending.** Full run after every commit.

---

## 6. Part 5 — proposals (NOT built; ranked by value-to-risk)

**P5-1 · Protect the surveillance data source from scripted writes** *(value: high · risk if wrong: medium)*
`/api/scan` and `/api/scans/sync` need an abuse story before M8: per-IP/device rate limits, per-route body-size caps, a per-source daily contribution cap feeding the aggregator, and an anomaly signal (one source generating many flagged scans in one district is itself a signal, not data). Design carefully: over-aggressive limits would block legitimate shared-phone/extension-agent usage patterns common in rural Ethiopia, and any device identifier must not break the anonymity promise. This is the single most valuable open item.

**P5-2 · Let the authoritative verdict count** *(value: high · risk: medium — changes rate arithmetic)*
(a) `effectiveStatus`/surveillance prefer `synced_status` over the provisional offline `result_status` when present; (b) at sync, resolve `CONFIRMED_BY_USER` to the live verify verdict (exactly what the online YES path does), so offline confirmations enter the rates. Both currently err conservative (undercount); fixing changes surveillance numbers, so it needs a deliberate decision + updated tests, not an auditor's unilateral edit.

**P5-3 · Drop query-string secret carriers** *(value: medium · risk: low)*
Remove `?token=` (map UI already uses the header) and, if Africa's Talking config permits header auth, `?secret=`. Breaking change for anything relying on the query form — verify AT's webhook capabilities first.

**P5-4 · Close the queue flush/update race** *(value: medium · risk: low-medium)*
Either re-read each item before delete and re-post changed ones, or version items and delete only matching versions. Touches the offline CONFIRM path — needs its own tests.

**P5-5 · Status-accurate sync-danger notice** *(value: medium · risk: low, blocked on translation)*
Add `msg.sync_danger_banned` (en/am/om, native-reviewed) and route `showSyncNotice`'s ignored status argument to pick text + `verdict_banned` clip. Blocked on the same native-review pipeline as all locale content — do not machine-translate.

**P5-6 · Localized HELP words** *(value: medium · risk: medium — safety vocabulary)*
Add native-reviewed help-word synonyms for am/om/ti/so/aa to `parseCommand` (the "any language" half of I-7). Must come from native speakers, like the route words — do not invent them. Ship with tests per language.

**P5-7 · Abuse-resistant audit log** *(value: low-medium · risk: low)*
Rate-limit or sample `surveillance_denied` events per IP so the audit trail can't be flooded by an unauthenticated attacker (F-9).

**P5-8 · M8 deploy hardening checklist** *(value: high when M8 starts · risk: low)*
The release gate now refuses in production — the deploy config must set `NODE_ENV=production`, run `npm test` + `npm audit` in CI, move the SMS rate limiter to a shared store (F-10), set real `ADMIN_TOKEN`/`AT_WEBHOOK_SECRET`/`POISON_CENTRE_NUMBER`, and NOT ship until the SAFETY.md sign-off table has a real row in it.

**Declined even as proposals:** exposing any finer-grained surveillance (per-shop/per-point view) — high regulator appeal, and exactly the defamation machine SAFETY.md forbids; LLM-assisted translation of locale stubs — speed at the cost of the reviewed-strings boundary. Neither is worth the boundary it crosses.

---

## 7. Verdict

**The safety doctrine is genuinely intact where it was designed-in, and the audit found its gaps exactly where design attention ran out: at the unauthenticated wire.** The retriever-not-adviser boundary, the CONFIRM rule, the emergency path, the asymmetric cache, and the reachability rule all held under code-path tracing, adversarial grepping, and dynamic probing — these are real invariants with mostly-real tests, not slogans. The failures that did exist (sync accepting arbitrary verdict strings including wire-claimed UNREGISTERED, a poison item wedging the offline queue, a release gate that warned but obeyed nothing, "contains HELP" narrowed to "starts with HELP") were all boundary failures, and all are now fixed and test-enforced. The single biggest remaining risk is **F-2/P5-1: the surveillance layer sits on a data source anyone can write to, unauthenticated and unthrottled** — the aggregation floors make casual poisoning invisible but scripted poisoning merely cheap, and this must be addressed before M8 makes the map real. Behind it stands the honest, already-documented gap that no safety content in the system — first-aid steps, translations, fuzzy threshold, registry data — has yet met the real world: the release gate now physically enforces that this build cannot serve a farmer until it does.

---
*All six fix commits are on `master` after `7e6e303`. Nothing in Part 5 was implemented. Pausing for human review, per the brief.*
