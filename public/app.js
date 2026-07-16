/* ==========================================================================
   Sebil Tena PWA — vanilla, no framework (see DECISIONS.md for the why).
   Consumes the existing APIs: /api/scan, /api/verify-number, /api/dosage.
   No dosage/safety value is ever produced on the client — all come from the
   server responses. This file only renders + speaks what the server returns.
   ========================================================================== */
(() => {
  "use strict";

  const LANGS = ["am", "om", "ti", "so", "aa", "en"];
  const FALLBACK = "en";

  // Dose unit phrases -> canonical unit clip keys (docs/RECORDING_SCRIPT.md).
  const UNIT_KEYS = {
    "kg per hectare": "unit_kg_per_hectare",
    "l per hectare": "unit_l_per_hectare",
    "ml per litre of water": "unit_ml_per_litre",
    "g per litre of water": "unit_g_per_litre",
    "ml per knapsack": "unit_ml_per_knapsack",
  };
  // Content -> canonical audio-clip key maps (recording script). Display text
  // still comes from /locales; only the AUDIO key is canonical here.
  const VERDICT_AUDIO = {
    VERIFIED: "verdict_verified", CONFIRM: "verdict_confirm",
    UNREGISTERED: "verdict_unregistered", BANNED: "verdict_banned",
    SUSPENDED: "verdict_banned", // no separate suspended clip; "do not use"
    EXPIRED: "verdict_expired", UNCONFIRMED: "verdict_unconfirmed",
  };
  const PPE_AUDIO = {
    gloves: "ppe_gloves", face_mask: "ppe_mask", goggles: "ppe_goggles",
    long_sleeves: "ppe_overall", boots: "ppe_boots",
  };
  const HAZARD_AUDIO = { // WHO class -> danger clip (5 levels, 1:1 — see M4.5 Part B)
    Ia: "hazard_extreme", Ib: "hazard_high", II: "hazard_moderate",
    III: "hazard_low", U: "hazard_unlikely",
  };
  // Universal first-aid: ordered atomic aid_* clips per route (used when no
  // product is identified). Each has a recorded clip + localized display text.
  const ROUTE_UNIVERSAL_STEPS = {
    skin: ["aid_remove_clothes", "aid_rinse_skin", "aid_no_food_drink", "aid_keep_container", "aid_seek_help"],
    eyes: ["aid_rinse_eyes", "aid_keep_container", "aid_seek_help"],
    swallowed: ["aid_do_not_vomit", "aid_no_food_drink", "aid_keep_container", "aid_seek_help", "aid_if_unconscious"],
    breathed: ["aid_move_air", "aid_seek_help", "aid_if_unconscious"],
  };

  const CROP_EMOJI = {
    potato: "🥔", tomato: "🍅", onion: "🧅", wheat: "🌾", coffee: "☕",
    maize: "🌽", sorghum: "🌾", teff: "🌾", barley: "🌾", vegetables: "🥬",
    cereals: "🌾", stored_grain: "🌾", grape: "🍇", citrus: "🍊", cotton: "🧵",
    sugarcane: "🎋", non_crop: "🟫", pre_plant: "🌱",
  };
  const PPE_EMOJI = {
    gloves: "🧤", face_mask: "😷", goggles: "🥽", long_sleeves: "👕", boots: "🥾",
  };
  const ROUTE_EMOJI = { skin: "🤚", eyes: "👁️", swallowed: "👄", breathed: "🫁" };
  const VERDICT = {
    VERIFIED:     { tone: "safe",    symbol: "✓" },
    CONFIRM:      { tone: "caution", symbol: "?" },
    EXPIRED:      { tone: "caution", symbol: "⌛" },
    STALE:        { tone: "caution", symbol: "⏳" }, // cached VERIFIED gone stale (M6)
    UNCONFIRMED:  { tone: "caution", symbol: "?" },
    UNREGISTERED: { tone: "danger",  symbol: "!" },
    BANNED:       { tone: "danger",  symbol: "⛔" },
    SUSPENDED:    { tone: "danger",  symbol: "⛔" },
  };

  // Offline caching windows (mirror server config; see DECISIONS.md).
  const OFFLINE = { staleAfterDays: 90, refreshAfterDays: 7 };

  const state = {
    lang: localStorage.getItem("mg_lang") || "am",
    dict: {},        // selected-language strings
    en: {},          // english fallback
    geoConsent: localStorage.getItem("mg_geo") || null, // 'yes' | 'no' | null
    lastResult: null,
    langMeta: {},         // { code: { native, complete } } — drives the fallback badge
    stream: null,
    session: null,        // active ingredient of the last identified product
    recent: [],           // recent identified products (for emergency picker)
    bundle: null,         // cached emergency bundle
    emergencyProduct: null, // active ingredient chosen for the current emergency
    offline: { registryReady: false, meta: null, preparing: false, ocrReady: false, ocrWarming: false }, // M6 offline state
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---- i18n --------------------------------------------------------------
  function get(dict, dotted) {
    return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
  }
  function t(key) {
    const v = get(state.dict, key);
    if (v != null) return v;
    const f = get(state.en, key);
    return f != null ? f : key;
  }
  async function loadLang(lang) {
    const [sel, en] = await Promise.all([
      fetch(`/locales/${lang}.json`).then((r) => r.json()).catch(() => ({})),
      lang === FALLBACK ? Promise.resolve(null) : fetch(`/locales/en.json`).then((r) => r.json()).catch(() => ({})),
    ]);
    state.dict = sel || {};
    state.en = en || sel || {};
  }

  // ---- Voice: delegate ENTIRELY to AudioLayer (clip -> TTS -> silent). -----
  // This file must not touch speechSynthesis directly (see audio.js).
  // An item is a phrase-key string or { key, text } (text = TTS bridge fallback).
  const speak = (item) => window.AudioLayer.speak(item, state.lang);
  const speakSeq = (items) => window.AudioLayer.speakSequence(items, state.lang);
  const stopSpeaking = () => window.AudioLayer.stopSpeaking();

  // Verdict -> canonical clip. The recorded verdict clip conveys the full
  // meaning; text fallback (headline + message) drives the TTS bridge.
  function verdictItems(status, headline, message) {
    const key = VERDICT_AUDIO[status] || "verdict_unconfirmed";
    const text = [headline, message].filter(Boolean).join(". ");
    return [{ key, text }];
  }

  // Parse a stored dose string into a value + unit clip key (best-effort).
  function parseDose(str) {
    const m = /^\s*(\d+(?:\.\d)?)\s*(.*\S)?\s*$/.exec(str || "");
    if (!m) return null;
    const unitText = (m[2] || "").trim();
    return { value: parseFloat(m[1]), unitKey: UNIT_KEYS[unitText.toLowerCase()] || null, unitText };
  }

  // ---- Navigation --------------------------------------------------------
  function show(view) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    const n = $(`#view-${view}`);
    if (n) n.classList.add("is-active");
    if (view !== "camera") stopCamera();
    window.scrollTo(0, 0);
  }

  // ---- Static UI strings -------------------------------------------------
  function paintChrome() {
    document.documentElement.lang = state.lang;
    $("#appName").textContent = t("ui.app_name");
    $("#tagline").textContent = t("ui.tagline");
    $("#scanLabel").textContent = t("ui.scan_button");
    $("#sosLabel").textContent = t("ui.emergency");
    $("#uploadLabel").textContent = t("ui.upload_photo");
    $("#loadingText").textContent = t("ui.reading");
    $("#langLabel").textContent = get(state.dict, "_native") || state.lang;
    $("#langTitle").textContent = t("ui.language");
    $("#geoText").textContent = t("ui.share_location");
    $("#geoAllow").textContent = t("ui.allow");
    $("#geoSkip").textContent = t("ui.skip");
    // Keep the demonstration banner in the current language.
    const sb = $("#stagingBanner span:last-child");
    if (sb) sb.textContent = t("ui.staging_notice");
    paintHome();
  }

  // ---- Homepage (M9) — a front door, never a gate --------------------------
  // Above the fold: brand + tagline + ONE hero action (+ the global emergency
  // button and language switcher). Below: the story, for people who scroll.
  // A farmer never needs the story zone to act.
  const STORY = [
    { id: "how", title: "home.how_title", items: [
      ["📷", "home.how_1"], ["✅", "home.how_2"], ["🔊", "home.how_3"],
    ], numbered: true },
    { id: "protect", title: "home.protect_title", items: [
      ["🚫", "home.protect_1"], ["🌱", "home.protect_2"], ["🛡️", "home.protect_3"], ["🆘", "home.protect_4"],
    ] },
    { id: "real", title: "home.real_title", items: [
      ["📴", "home.real_1"], ["✉️", "home.real_2"], ["🗣️", "home.real_3"], ["🔊", "home.real_4"],
    ] },
  ];
  function paintHome() {
    $("#homeName").textContent = t("ui.app_name");
    $("#homeTag").textContent = t("ui.tagline");
    $("#heroScanLabel").textContent = t("ui.scan_button");
    const about = $("#aboutLabel");
    if (about) about.textContent = t("ui.app_name");
    paintSkipIntro();
    const story = $("#homeStory");
    if (!story) return;
    story.innerHTML = "";
    for (const sec of STORY) {
      const card = el("section", "story-card");
      card.appendChild(el("h2", "story-title", esc(t(sec.title))));
      const list = el("div", "story-list");
      sec.items.forEach(([icon, key], i) => {
        const row = el("div", "story-item");
        row.innerHTML =
          `<span class="story-icon" aria-hidden="true">${icon}</span>` +
          (sec.numbered ? `<span class="story-num">${i + 1}</span>` : "") +
          `<span class="story-text">${esc(t(key))}</span>`;
        list.appendChild(row);
      });
      card.appendChild(list);
      story.appendChild(card);
    }
    // How it stays safe — the honest design paragraph (retriever, not adviser).
    const safe = el("section", "story-card story-safe");
    safe.appendChild(el("h2", "story-title", esc(t("home.safe_title"))));
    safe.appendChild(el("p", "story-body", esc(t("home.safe_body"))));
    story.appendChild(safe);
    // Quiet, honest footer — the demonstration note only (no source-code link).
    const foot = el("footer", "home-foot");
    foot.innerHTML = `<p>${esc(t("home.demo_note"))}</p>`;
    story.appendChild(foot);
  }
  // Returning-visitor speed (M9 Part B): once the skip is chosen, the app opens
  // on the scan screen. Reversible from the same control on the homepage.
  const homeSkipOn = () => localStorage.getItem("mg_home_skip") === "true";
  function paintSkipIntro() {
    const b = $("#skipIntro");
    if (b) b.textContent = homeSkipOn() ? "✓ " + t("home.skip_on") : t("home.skip") + " →";
  }

  // ---- Language sheet ----------------------------------------------------
  // Fetch each locale's native name + completeness once. Incomplete languages
  // are stubs that fall back to English — we must NOT present them as working.
  async function ensureLangMeta() {
    if (Object.keys(state.langMeta).length) return state.langMeta;
    const metas = await Promise.all(
      LANGS.map((l) =>
        fetch(`/locales/${l}.json`).then((r) => r.json())
          .then((d) => ({ code: l, native: d._native || l, complete: l === "en" ? true : d.complete === true }))
          .catch(() => ({ code: l, native: l, complete: l === "en" }))
      )
    );
    for (const m of metas) state.langMeta[m.code] = m;
    return state.langMeta;
  }
  const isLangComplete = (lang) => lang === "en" || state.langMeta[lang]?.complete === true;

  async function buildLangList() {
    await ensureLangMeta();
    const list = $("#langList");
    list.innerHTML = "";
    LANGS.forEach((l) => {
      const m = state.langMeta[l];
      const b = el("button", "lang-option" + (l === state.lang ? " is-current" : "") + (m.complete ? "" : " is-incomplete"));
      b.innerHTML = `<span class="lang-native">${esc(m.native)}</span>` +
        (m.complete ? "" : `<span class="lang-soon">${esc(t("ui.lang_coming_soon"))}</span>`);
      b.onclick = () => selectLang(l);
      list.appendChild(b);
    });
  }

  function hideLangBanner() {
    const b = $("#langBanner");
    if (b) { b.hidden = true; b.innerHTML = ""; }
  }

  // Incomplete language chosen: NEVER pick a fallback for the farmer. Show an
  // interactive banner offering both Amharic and English; apply only on their tap.
  function showLangOffer(requested) {
    const banner = $("#langBanner");
    if (!banner) return;
    const native = state.langMeta[requested]?.native || requested;
    banner.innerHTML = "";
    banner.appendChild(el("span", "lang-banner-msg", `⚠ ${esc(native)} — ${esc(t("ui.lang_coming_soon"))}`));
    const row = el("span", "lang-banner-actions");
    for (const code of ["am", "en"]) {
      const btn = el("button", "lang-banner-btn", esc(state.langMeta[code]?.native || code));
      btn.onclick = () => { logLangFallback(requested, code); applyLang(code); };
      row.appendChild(btn);
    }
    banner.appendChild(row);
    banner.hidden = false;
  }

  function logLangFallback(requested, chosen) {
    try {
      const body = JSON.stringify({ requested, chosen, channel: "app" });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/lang-fallback", new Blob([body], { type: "application/json" }));
      else fetch("/api/lang-fallback", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    } catch { /* logging must never break the UI */ }
  }

  // Apply a language for real. Only ever called with a COMPLETE language.
  async function applyLang(lang) {
    state.lang = lang;
    localStorage.setItem("mg_lang", lang);
    await ensureLangMeta();
    await loadLang(lang);
    paintChrome();
    hideLangBanner();
    if ($("#view-result").classList.contains("is-active") && state.lastResult) renderResult(state.lastResult);
  }

  // Switcher entry point.
  async function selectLang(lang) {
    $("#langSheet").hidden = true;
    await ensureLangMeta();
    if (isLangComplete(lang)) return applyLang(lang);
    // Offer both; announce in English; log the demand (chosen unknown yet).
    showLangOffer(lang);
    window.AudioLayer.speak({ key: "lang_offer", text: t("ui.lang_offer_spoken") }, "en");
    logLangFallback(lang, null);
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  // Returns net.js's { online, ok, data } — online-ness is decided by outcome.
  async function postScan(imageBase64) {
    const body = { imageBase64, lang: state.lang };
    if (state.geoConsent === "yes") {
      const pos = await getPosition().catch(() => null);
      if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
    }
    return window.Net.requestJSON("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  // Resolve a Tier-2 CONFIRM (records the outcome on the originating scan row).
  const confirmScan = (scanId, confirm, registrationNo) =>
    api("/api/scan/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId, confirm, registrationNo, lang: state.lang }),
    });
  const getDosage = (pesticideId, crop) =>
    api(`/api/dosage?pesticideId=${encodeURIComponent(pesticideId)}&crop=${encodeURIComponent(crop)}&lang=${state.lang}`);

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject();
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        reject,
        { timeout: 6000, maximumAge: 60000 }
      );
    });
  }

  // ---- Scan flow ---------------------------------------------------------
  async function runScan(imageBase64) {
    show("loading");
    setLoadingText(t("ui.reading"));            // "Reading the label…"
    speak({ key: "scanning", text: t("ui.reading") });
    startVisionHint();                          // a long wait -> "Checking more carefully…"
    // Online-ness is decided by OUTCOME (net.js), never by the onLine flag.
    const r = await postScan(imageBase64);
    stopVisionHint();
    if (r.online) flushQueue(); // reachable -> flush any queued offline scans
    if (r.online && r.ok) {
      logScanQuality(r.data.verify?.status || r.data.status, false); // tuning signal -> events
      return renderResult(r.data);
    }
    if (r.online && !r.ok) { console.warn("scan http error", r.status); return renderOffline(); }
    // Unreachable (timeout / network error) -> local OCR + cached registry.
    return scanOffline(imageBase64);
  }

  // Loading states (M11 Part C): no silent spinners. "Reading the label…" first;
  // if the request runs long the server is likely trying the vision fallback, so
  // switch to a distinct "Checking more carefully…" state (spoken once).
  function setLoadingText(txt) { const n = $("#loadingText"); if (n) n.textContent = txt; }
  function startVisionHint() {
    stopVisionHint();
    state.visionTimer = setTimeout(() => {
      setLoadingText(t("ui.checking_more"));
      speak({ key: "checking_more", text: t("ui.checking_more") });
    }, 2200);
  }
  function stopVisionHint() { if (state.visionTimer) { clearTimeout(state.visionTimer); state.visionTimer = null; } }

  // Anonymized quality telemetry -> events (NEVER scans, NEVER an image). This is
  // exactly the data needed to tune the provisional thresholds during the pilot.
  function beacon(type, payload) {
    try {
      const body = JSON.stringify({ type, payload });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/client-event", new Blob([body], { type: "application/json" }));
      else fetch("/api/client-event", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    } catch { /* telemetry must never break the UI */ }
  }
  function logScanQuality(status, offline) {
    const q = state.lastQuality || {};
    const c = state.quality || { retakes: 0, useAnyway: 0 };
    beacon("scan_quality", {
      blur: q.blur ?? null, exposure: q.exposure ?? null, mean: q.mean ?? null, edge_density: q.edgeDensity ?? null,
      retakes: c.retakes, use_anyway: c.useAnyway, status: status || null, offline: !!offline,
    });
  }
  // Derive the worst quality problem from the last attempt's signals (for tips).
  const Q_TIP_CTX = { blur: "quality.tip_blur", dark: "quality.tip_dark", bright: "quality.tip_bright", far: "quality.tip_far" };
  function qualityProblemFromSignals() {
    const q = state.lastQuality; if (!q || !window.Quality) return null;
    const D = window.Quality.DEFAULTS;
    if (q.blur != null && q.blur < D.blurThreshold) return "blur";
    if (q.exposure === "dark") return "dark";
    if (q.exposure === "bright") return "bright";
    if (q.edgeDensity != null && q.edgeDensity < D.minEdgeDensity) return "far";
    return null;
  }
  // Offline scan path: client OCR (Part A) -> cached registry (Part B). If OCR
  // is not ready yet, fall back to the conservative "no connection" state.
  async function scanOffline(imageBase64) {
    const text = await runClientOcr(imageBase64).catch(() => null);
    if (!text) return renderOffline();
    const candidates = buildOcrCandidates(text);
    const readRegNo = extractReadReg(candidates);
    const vres = await window.Registry.verifyOffline(candidates, { now: new Date(), staleAfterDays: OFFLINE.staleAfterDays });
    // Queue the offline scan for sync (geotag only with consent; no identity).
    const geo = state.geoConsent === "yes" ? await getPosition().catch(() => null) : null;
    const status = vres.matchTier === 2 ? "CONFIRM" : (vres.verdict?.status || "UNCONFIRMED");
    vres._queueUuid = await window.Queue.enqueue({
      registration_no_read: readRegNo,
      result_status: status,
      confidence: vres.matchTier === 1 ? "high" : vres.matchTier === 2 ? "medium" : "low",
      lat: geo?.lat ?? null, lon: geo?.lon ?? null, language: state.lang,
    });
    logScanQuality(status, true); // tuning signal -> events (queued/best-effort while offline)
    return renderOfflineVerify(vres);
  }
  // Best-effort "what reg-no did OCR read" for the queued row (longest alnum token with a digit).
  function extractReadReg(candidates) {
    let best = null;
    for (const c of candidates) {
      const up = String(c).toUpperCase();
      const m = up.match(/[A-Z0-9\/-]{3,}/g) || [];
      for (const tk of m) if (/\d/.test(tk) && (!best || tk.length > best.length)) best = tk;
    }
    return best;
  }
  // Client OCR (tesseract.js). Returns label text, or null if OCR isn't ready.
  async function runClientOcr(imageBase64) {
    if (!window.OCR) return null;
    try { return await window.OCR.recognize(imageBase64); }
    catch (e) { console.warn("client OCR failed:", e && e.message); return null; }
  }
  // Record an offline CONFIRM answer on the queued scan so it syncs resolved.
  function queueConfirmResolution(queueUuid, confirm) {
    if (!queueUuid) return;
    const resolved_status = confirm ? "CONFIRMED_BY_USER" : "REJECTED_BY_USER";
    window.Queue.update(queueUuid, { resolved_status }).catch(() => {});
  }
  // Obtain an app-issued write token (M7.5 B) — opaque, PII-free, anti-abuse
  // (NOT a farmer account). Cached in localStorage; re-registered on demand.
  async function ensureDeviceToken(force) {
    if (!force && localStorage.getItem("mg_device_token")) return;
    try {
      const r = await window.Net.requestJSON("/api/register-device", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (r.online && r.ok && r.data && r.data.token) localStorage.setItem("mg_device_token", r.data.token);
    } catch (e) { console.warn("device register failed:", e); }
  }
  // Flush queued offline scans when reachable; notify on any authoritative upgrade.
  // A 401 means the write token expired -> re-register once and retry.
  async function flushQueue(retried) {
    try {
      await ensureDeviceToken();
      const r = await window.Queue.flush();
      if (r.tokenExpired && !retried) { await ensureDeviceToken(true); return flushQueue(true); }
      if (r.flushed && r.upgrades && r.upgrades.length) notifyUpgrades(r.upgrades);
    } catch (e) { console.warn("queue flush failed:", e); }
  }
  function notifyUpgrades(upgrades) {
    // Most important: a scan that was UNCONFIRMED offline is really UNREGISTERED.
    for (const u of upgrades) {
      if (u.to === "UNREGISTERED" || u.to === "BANNED" || u.to === "SUSPENDED") {
        const when = u.created_at ? ` (${new Date(u.created_at).toISOString().slice(0, 10)})` : "";
        showSyncNotice(fillDate(t("msg.sync_danger"), when), u.to);
      }
    }
  }
  const buildOcrCandidates = (text) => {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 2);
    const tokens = raw.toUpperCase().split(/[^A-Z0-9]+/).filter((tk) => tk.length >= 2);
    return [...lines, ...tokens];
  };

  // Turn a Registry.verifyOffline result into a renderResult-compatible payload
  // (built from the CACHED record + verdict.js — never a network call).
  function offlineVerifyToResult(vres) {
    if (vres.matchTier === 2) {
      return {
        status: "CONFIRM", matchTier: 2, needsConfirmation: true, offline: true,
        candidate: vres.candidate, confirmRegistrationNo: vres.record.registration_no,
        offlineRecord: vres.record, queueUuid: vres._queueUuid,
        headline: t("status.CONFIRM"), message: t("msg.confirm"),
      };
    }
    const v = vres.verdict;
    if (v.status === "UNCONFIRMED") {
      return { status: "UNCONFIRMED", offline: true, headline: t("status.UNCONFIRMED"), message: t("msg.conservative") };
    }
    const rec = vres.record;
    const dateStr = v.checked_at ? new Date(v.checked_at).toISOString().slice(0, 10) : "?";
    const headline = v.status === "STALE" ? t("status.STALE") : t(`status.${v.status}`);
    let message;
    if (v.status === "VERIFIED") message = fillDate(t("msg.verified_as_of"), dateStr);
    else if (v.status === "STALE") message = fillDate(t("msg.stale"), dateStr);
    else message = t(`msg.${v.status.toLowerCase()}`);
    const verify = {
      status: v.status,
      product: { id: rec.key, registration_no: rec.registration_no, product_name: rec.product_name, active_ingredient: rec.active_ingredient, hazard_class: rec.hazard_class, expiry_date: rec.expiry_date },
      safety: v.showSafety ? { hazard_class: rec.hazard_class, ppe_required: rec.ppe_required || [], first_aid: rec.first_aid || {}, approved_crops: rec.approved_crops || [] } : null,
      dosages: v.showDose ? (rec.dosages || []) : [],
      offlineDosages: rec.dosages || [],   // used by the offline dose picker
      headline, message, disclaimer: t("disclaimer.official"),
    };
    return { status: v.status, matchTier: vres.matchTier, offline: true, verify };
  }
  const fillDate = (s, d) => String(s).replace("{date}", d);

  function renderOfflineVerify(vres) {
    if (vres.matchTier === 2) {
      // Offline CONFIRM: YES reveals the verdict from the cached record; both
      // answers queue for sync (Part C). Dosage still withheld until YES.
      const res = offlineVerifyToResult(vres);
      renderResult(res);
      return;
    }
    renderResult(offlineVerifyToResult(vres));
    showCacheAge();
  }
  // Expose for verification (offline path, no network).
  function verifyOfflineAndRender(candidateStrings) {
    return window.Registry.verifyOffline(candidateStrings, { now: new Date(), staleAfterDays: OFFLINE.staleAfterDays })
      .then((vres) => renderOfflineVerify(vres));
  }

  // ---- Offline preparation + cache-age indicator (M6 Parts A + B) ---------
  // Download the registry + warm up client OCR once online, in the BACKGROUND.
  // Never blocks the UI; if it never finishes, the app still works online.
  async function prepareOffline() {
    warmUpOcr(); // background, independent of the registry fetch
    if (state.offline.preparing) return;
    try {
      state.offline.meta = await window.Registry.meta();
      state.offline.registryReady = !(await window.Registry.isEmpty());
    } catch { /* IndexedDB unavailable -> online-only */ }
    updateOfflineChip();
    const savedAt = state.offline.meta?.saved_at ? Date.parse(state.offline.meta.saved_at) : 0;
    const ageDays = savedAt ? (Date.now() - savedAt) / 86400000 : Infinity;
    if (state.offline.registryReady && ageDays <= OFFLINE.refreshAfterDays) return; // fresh enough
    state.offline.preparing = true;
    updateOfflineChip();
    const r = await window.Net.requestJSON("/api/registry-bundle");
    if (r.online && r.ok && r.data) {
      try {
        await window.Registry.saveBundle(r.data);
        state.offline.meta = await window.Registry.meta();
        state.offline.registryReady = true;
        console.info(`[offline] registry cached: ${r.data.count} products, ~${(JSON.stringify(r.data).length / 1024).toFixed(0)} KB`);
      } catch (e) { console.warn("registry cache failed:", e); }
    }
    state.offline.preparing = false;
    updateOfflineChip();
  }
  function warmUpOcr() {
    if (!window.OCR || state.offline.ocrReady || state.offline.ocrWarming) return;
    state.offline.ocrWarming = true;
    window.OCR.onProgress(() => updateOfflineChip());
    updateOfflineChip();
    window.OCR.warmUp().then((ok) => {
      state.offline.ocrReady = ok; state.offline.ocrWarming = false;
      if (ok) speak({ key: "offline_ready", text: t("ui.offline_ready") });
      updateOfflineChip();
    });
  }

  function mountOfflineChip() {
    if ($("#offlineChip")) return;
    const chip = el("div", "offline-chip");
    chip.id = "offlineChip";
    chip.hidden = true;
    document.body.appendChild(chip);
  }
  function relativeDays(iso) {
    if (!iso) return "?";
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (d <= 0) return t("ui.days_today") || "today";
    return `${d} ${t("ui.days")}`;
  }
  function updateOfflineChip() {
    const chip = $("#offlineChip"); if (!chip) return;
    const ocrPct = window.OCR ? Math.round(window.OCR.progress() * 100) : 0;
    const busy = state.offline.preparing || state.offline.ocrWarming;
    if (busy) {
      chip.className = "offline-chip is-prep";
      const pct = state.offline.ocrWarming && ocrPct > 0 && ocrPct < 100 ? ` ${ocrPct}%` : "";
      chip.textContent = "⏳ " + (t("ui.preparing_offline") || "Preparing offline mode…") + pct;
      chip.hidden = false;
    } else if (state.offline.registryReady && state.offline.ocrReady) {
      // Briefly confirm offline readiness, then quiet down.
      chip.className = "offline-chip is-ready";
      chip.textContent = "✓ " + (t("ui.offline_ready") || "Offline ready");
      chip.hidden = false;
      clearTimeout(chip._t);
      chip._t = setTimeout(() => { chip.hidden = true; }, 3000);
    } else {
      chip.hidden = true;
    }
  }
  // Persistent cache-age line shown when a verdict was served from the cache.
  function showCacheAge() {
    const meta = state.offline.meta;
    const note = el("div", "cache-age", `📴 ${esc(t("ui.offline_saved") || "Saved data")} · ${esc(relativeDays(meta?.checked_at || meta?.saved_at))}`);
    $("#resultBody").prepend(note);
  }
  // Dismissible red notice — a synced scan turned out dangerous (M6 Part C).
  function showSyncNotice(msg) {
    let n = $("#syncNotice");
    if (!n) { n = el("div", "sync-notice"); n.id = "syncNotice"; document.querySelector(".topbar").insertAdjacentElement("afterend", n); }
    n.innerHTML = "";
    n.appendChild(el("span", null, `⚠ ${esc(msg)}`));
    const x = el("button", "sync-notice-x", "✕");
    x.onclick = () => { n.hidden = true; };
    n.appendChild(x);
    n.hidden = false;
    speak({ key: "verdict_unregistered", text: msg });
  }
  function renderOffline() {
    show("result");
    $("#resultBody").innerHTML = "";
    const card = el("div", "verdict verdict--caution");
    card.innerHTML = `
      <div class="verdict-badge">📡</div>
      <div class="verdict-title">${esc(t("ui.no_connection"))}</div>
      <div class="verdict-actions"></div>`;
    const again = el("button", "btn btn-amber btn-block", esc(t("ui.try_again")));
    again.onclick = () => show("scan");
    card.querySelector(".verdict-actions").appendChild(again);
    $("#verdictCard").replaceChildren(card);
    speak({ key: "verdict_offline", text: t("ui.no_connection") });
  }

  // ---- Result rendering (status-driven) ----------------------------------
  function renderResult(res) {
    state.lastResult = res;
    show("result");
    $("#resultBody").innerHTML = "";

    // A Tier-1 scan carries the full verify.js record under `verify`.
    const record = res.verify || null;
    const status = record ? record.status : res.status;
    const headline = (record ? record.headline : res.headline) || t(`status.${status}`);
    const message = (record ? record.message : res.message) || "";
    const meta = VERDICT[status] || VERDICT.UNCONFIRMED;

    const card = el("div", `verdict verdict--${meta.tone}`);
    card.innerHTML = `
      <div class="verdict-badge">${esc(meta.symbol)}</div>
      <div class="verdict-title">${esc(headline)}</div>
      <div class="verdict-msg">${esc(message)}</div>
      <div class="verdict-actions"></div>
      <div class="replay-wrap"></div>`;
    const actions = card.querySelector(".verdict-actions");

    // Replay button (auto-speak is default; this is for noisy fields).
    const replay = el("button", "btn btn-replay", "🔊 " + esc(t("ui.play_again")));
    replay.onclick = () => speakSeq(verdictItems(status, headline, message));
    card.querySelector(".replay-wrap").appendChild(replay);

    // Remember any identified product's ingredient for a later emergency
    // (so the farmer never has to re-scan while panicking).
    if (record && record.product && record.product.active_ingredient) {
      state.session = {
        activeIngredient: record.product.active_ingredient,
        product_name: record.product.product_name,
        registration_no: record.product.registration_no,
      };
      state.recent = [state.session, ...state.recent.filter((r) => r.activeIngredient !== state.session.activeIngredient)].slice(0, 5);
    }

    if (status === "CONFIRM") {
      renderConfirm(res, card, actions);
    } else if (status === "VERIFIED") {
      addScanAgain(actions);
      $("#verdictCard").replaceChildren(card);
      renderRecord(record); // safety + dosage
    } else {
      // UNREGISTERED / BANNED / SUSPENDED / EXPIRED / UNCONFIRMED — no dosage.
      // A conservative UNCONFIRMED / low-confidence read is often a bad photo —
      // offer "Try another photo" with a contextual tip (M11 Part C).
      const lowConf = status === "UNCONFIRMED" || res.confidence === "low" || record?.confidence === "low";
      if (lowConf) addTryAnotherPhoto(actions);
      addAgentAction(actions);
      addScanAgain(actions);
      $("#verdictCard").replaceChildren(card);
    }

    // Auto-speak the verdict the instant it appears. For UNCONFIRMED, append the
    // spoken "try another photo" + a contextual tip AFTER the verdict.
    const spoken = verdictItems(status, headline, message);
    if (status === "UNCONFIRMED") {
      spoken.push({ key: "try_another", text: t("ui.try_another_photo") });
      const prob = qualityProblemFromSignals();
      if (prob && Q_TIP_CTX[prob]) spoken.push({ key: "q_tip", text: t(Q_TIP_CTX[prob]) });
    }
    speakSeq(spoken);
  }

  // "Try another photo" action + one contextual tip from the failed attempt's
  // quality signals (if it was blurry, say so). Not spoken here (the verdict
  // sequence handles the audio, to avoid cancelling it).
  function addTryAnotherPhoto(actions) {
    const b = el("button", "btn btn-primary btn-block", "📷 " + esc(t("ui.try_another_photo")));
    b.onclick = () => show("scan");
    actions.appendChild(b);
    const prob = qualityProblemFromSignals();
    if (prob && Q_TIP_CTX[prob]) actions.appendChild(el("p", "try-tip", "💡 " + esc(t(Q_TIP_CTX[prob]))));
  }

  function renderConfirm(res, card, actions) {
    const c = res.candidate || {};
    const ident = el("div", "card");
    ident.innerHTML = `
      <div class="product-head">
        <span class="product-name">${esc(c.product_name || "")}</span>
        <span class="product-meta">${esc(t("ui.active_ingredient"))}: ${esc(c.active_ingredient || "")}</span>
      </div>`;
    // Transparency (M11 Part C): show the captured photo next to what was READ,
    // so the farmer confirming "is this my product?" can SEE the basis of the
    // match. This does not change the confirm logic or the dosage-withholding.
    const readText = res.registration_no_read || c.registration_no || c.product_name || "";
    if (state.lastPhoto && readText) {
      const cr = el("div", "confirm-read");
      cr.innerHTML =
        `<img src="${esc(state.lastPhoto)}" alt="">` +
        `<div class="read-what">` +
        `<div class="lbl">${esc(t("quality.read_as"))}</div>` +
        `<div class="val">${esc(readText)}</div></div>`;
      ident.appendChild(cr);
    }
    const yn = el("div", "yn-row");
    const yes = el("button", "btn btn-yes", "✓ " + esc(t("ui.yes")));
    const no = el("button", "btn btn-no", "✕ " + esc(t("ui.no")));
    yes.onclick = async () => {
      if (res.offline) {
        // Offline: reveal the verdict from the CACHED record (no network). The
        // resolution is queued for sync in Part C.
        const v = window.OfflineVerdict.computeVerdict(res.offlineRecord, { now: new Date(), staleAfterDays: OFFLINE.staleAfterDays });
        queueConfirmResolution(res.queueUuid, true);
        return renderOfflineVerify({ matchTier: 1, record: res.offlineRecord, verdict: v });
      }
      show("loading");
      try {
        // Resolve the scan row (resolved_status = verify verdict) and reveal it.
        const r = await confirmScan(res.scanId, true, res.confirmRegistrationNo);
        renderResult({ status: r.verify.status, verify: r.verify });
      } catch { renderOffline(); }
    };
    no.onclick = () => {
      // NO = counterfeit-suspicion signal.
      if (res.offline) queueConfirmResolution(res.queueUuid, false);
      else confirmScan(res.scanId, false, res.confirmRegistrationNo).catch(() => {});
      show("scan");
    };
    yn.append(yes, no);
    actions.appendChild(yn);
    $("#verdictCard").replaceChildren(card);
    // Put the identity card right under the verdict.
    $("#resultBody").replaceChildren(ident);
  }

  // Render the VERIFIED safety card + dosage picker from the server record.
  function renderRecord(record) {
    const body = $("#resultBody");
    body.innerHTML = "";
    if (!record || !record.product) return;

    // Product header
    const head = el("div", "card");
    head.innerHTML = `
      <div class="product-head">
        <span class="product-name">${esc(record.product.product_name)}</span>
        <span class="product-meta">${esc(t("ui.active_ingredient"))}: ${esc(record.product.active_ingredient)}</span>
        <span class="product-meta">${esc(t("ui.registration_no"))}: ${esc(record.product.registration_no)}</span>
      </div>`;
    body.appendChild(head);

    const safety = record.safety || {};
    const safetyItems = [];

    // Safety card: PPE icons + hazard band
    if (safety.ppe_required || safety.hazard_class) {
      const sc = el("div", "card");
      sc.appendChild(el("h3", null, "🛡️ " + esc(t("ui.wear_this"))));
      safetyItems.push({ key: "wear_protection", text: t("ui.wear_this") });
      const row = el("div", "ppe-row");
      (safety.ppe_required || []).forEach((p) => {
        const item = el("div", "ppe-item");
        item.innerHTML = `<span class="ppe-emoji">${PPE_EMOJI[p] || "🧰"}</span><span class="ppe-name">${esc(t("ppe." + p))}</span>`;
        row.appendChild(item);
        safetyItems.push({ key: PPE_AUDIO[p] || "ppe_gloves", text: t("ppe." + p) });
      });
      sc.appendChild(row);
      if (safety.hazard_class) {
        const hz = safety.hazard_class;
        const band = el("div", `hazard-band hazard-${esc(hz)}`);
        band.innerHTML = `<span>${esc(t("ui.danger_level"))}: ${esc(t("hazard." + hz))}</span><span class="hazard-class-chip">${esc(hz)}</span>`;
        sc.appendChild(band);
        safetyItems.push({ key: HAZARD_AUDIO[hz] || "hazard_moderate", text: `${t("ui.danger_level")}: ${t("hazard." + hz)}` });
      }
      body.appendChild(sc);
    }

    // Dosage picker (crops as big icons)
    const crops = (safety.approved_crops && safety.approved_crops.length
      ? safety.approved_crops
      : (record.dosages || []).map((d) => d.crop));
    if (crops.length) {
      const dc = el("div", "card");
      dc.appendChild(el("h3", null, "🌱 " + esc(t("ui.choose_crop"))));
      const grid = el("div", "crop-grid");
      crops.forEach((crop) => {
        const b = el("button", "crop-btn");
        b.innerHTML = `<span class="crop-emoji">${CROP_EMOJI[crop] || "🌿"}</span><span class="crop-name">${esc(t("crop." + crop))}</span>`;
        b.onclick = () => selectCrop(record.product.id, crop, b, grid, dc);
        grid.appendChild(b);
      });
      dc.appendChild(grid);
      body.appendChild(dc);
    }

    const disc = el("div", "disclaimer", esc(record.disclaimer || t("disclaimer.official")));
    body.appendChild(disc);

    // Speak verdict already done in renderResult; queue the safety clips next.
    if (safetyItems.length) {
      safetyItems.push({ key: "disclaimer", text: record.disclaimer || t("disclaimer.official") });
      setTimeout(() => speakSeq(safetyItems), 30);
    }
  }

  async function selectCrop(pesticideId, crop, btn, grid, container) {
    grid.querySelectorAll(".crop-btn").forEach((b) => b.classList.remove("is-selected"));
    btn.classList.add("is-selected");
    container.querySelectorAll(".dose-result").forEach((n) => n.remove());
    let dose;
    if (state.lastResult?.offline) {
      // Offline: dose comes from the CACHED record, never a network call.
      const ds = (state.lastResult.verify?.offlineDosages || []).find((d) => String(d.crop).toLowerCase() === String(crop).toLowerCase());
      dose = ds
        ? { covered: true, crop, dose_per_unit: ds.dose_per_unit, application_notes: ds.application_notes, pre_harvest_interval_days: ds.pre_harvest_interval_days }
        : { covered: false, crop, message: t("msg.crop_not_covered") };
    } else {
      try { dose = await getDosage(pesticideId, crop); }
      catch { return renderOffline(); }
    }

    const box = el("div", "dose-result" + (dose.covered ? "" : " dose-uncovered"));
    if (dose.covered) {
      box.innerHTML = `
        <div class="dose-label">${esc(t("ui.dose"))} — ${esc(t("crop." + crop))}</div>
        <div class="dose-big">${esc(dose.dose_per_unit)}</div>
        ${dose.application_notes ? `<div class="dose-notes">${esc(dose.application_notes)}</div>` : ""}
        ${dose.pre_harvest_interval_days != null
          ? `<div class="phi">⏳ ${esc(t("ui.wait_before_harvest"))}: ${esc(dose.pre_harvest_interval_days)} ${esc(t("ui.days"))}</div>` : ""}`;
      container.appendChild(box);
      // Compose the spoken dose from atomic clips (number + unit), then PHI.
      const parsed = parseDose(dose.dose_per_unit);
      let items;
      if (parsed) {
        items = window.AudioLayer.numberItems(parsed.value, {
          prefixKey: "dose_is", prefixText: t("ui.dose"),
          unitKey: parsed.unitKey, unitText: parsed.unitText,
        });
      } else {
        items = [{ key: "dose_text", text: dose.dose_per_unit }];
      }
      if (dose.pre_harvest_interval_days != null) {
        items.push(
          { key: "wait_before_harvest", text: t("ui.wait_before_harvest") },
          { key: `num_${dose.pre_harvest_interval_days}`, text: String(dose.pre_harvest_interval_days) },
          { key: "days", text: t("ui.days") }
        );
      }
      speakSeq(items);
    } else {
      box.innerHTML = `<div class="dose-big">⚠️ ${esc(t("crop." + crop))}</div>
        <div class="dose-notes">${esc(dose.message)}</div>`;
      container.appendChild(box);
      const agent = el("button", "btn btn-danger btn-block", "☎ " + esc(t("ui.contact_agent")));
      agent.style.marginTop = "12px";
      agent.onclick = () => show("emergency"); // placeholder route to agent/help
      container.appendChild(agent);
      speak({ key: "crop_not_covered", text: dose.message });
    }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function addScanAgain(actions) {
    const b = el("button", "btn btn-replay btn-block", "📷 " + esc(t("ui.scan_again")));
    b.onclick = () => show("scan");
    actions.appendChild(b);
  }
  function addAgentAction(actions) {
    const b = el("button", "btn btn-danger btn-block", "☎ " + esc(t("ui.contact_agent")));
    b.onclick = () => show("emergency"); // agent contact flow arrives with M4/M5
    actions.appendChild(b);
  }

  // ---- Camera ------------------------------------------------------------
  // A small offscreen canvas reused for cheap frame sampling (live light hint,
  // Part A) and the post-capture quality check (Part B). ~200px wide is plenty.
  const sampleCanvas = document.createElement("canvas");
  async function openCamera(isRetake) {
    show("camera");
    // A fresh scan session resets the quality counters (retakes accumulate only
    // across a retry of the SAME attempt). See M11 Part B/C.
    if (!isRetake) state.quality = { retakes: 0, useAnyway: 0 };
    // Framing guide: spoken once, written on the reticle. Never blocks capture.
    $("#frameHint").textContent = t("ui.fill_the_box");
    speak({ key: "fill_the_box", text: t("ui.fill_the_box") });
    state.lightSpoken = null;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
      });
      $("#cam").srcObject = state.stream;
      startLightSampling();
    } catch (err) {
      // Camera blocked/unavailable -> file fallback is always visible anyway.
      console.info("camera unavailable, using file fallback:", err && err.name);
    }
  }
  function stopCamera() {
    if (state.lightTimer) { clearInterval(state.lightTimer); state.lightTimer = null; }
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  }
  // Live lighting hint: sample the preview ~2x/sec to a tiny canvas, check mean
  // luminance, show a gentle icon hint. Sampling is cheap and off the preview
  // path, so it never lags the video. Each distinct hint is spoken once.
  function startLightSampling() {
    if (!window.Quality) return;
    state.lightTimer = setInterval(() => {
      const video = $("#cam");
      if (!video || !video.videoWidth) return;
      const w = 120, h = Math.max(1, Math.round(video.videoHeight * (w / video.videoWidth)));
      sampleCanvas.width = w; sampleCanvas.height = h;
      const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
      try {
        ctx.drawImage(video, 0, 0, w, h);
        const mean = window.Quality.meanLuminance(ctx.getImageData(0, 0, w, h));
        updateLightHint(window.Quality.lightHint(mean));
      } catch { /* sampling must never break the preview */ }
    }, 500);
  }
  function updateLightHint(hint) {
    const el = $("#lightHint");
    if (!el) return;
    if (hint === "ok") { el.hidden = true; return; }
    const map = { dark: ["🔅", "ui.hint_more_light"], bright: ["⚠️", "ui.hint_too_bright"] };
    const [icon, key] = map[hint];
    el.innerHTML = `<span aria-hidden="true">${icon}</span> ${esc(t(key))}`;
    el.hidden = false;
    // Speak a given hint only once per camera session (never nag).
    if (state.lightSpoken !== hint) { state.lightSpoken = hint; speak({ key: "light_" + hint, text: t(key) }); }
  }
  function capture() {
    const video = $("#cam");
    if (!video.videoWidth) { $("#fileInput").click(); return; }
    const canvas = $("#snap");
    const w = 1000, scale = w / video.videoWidth;
    canvas.width = w; canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    assessThenScan(canvas.toDataURL("image/jpeg", 0.7));
  }
  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => assessThenScan(reader.result);
    reader.readAsDataURL(file);
  }

  // ---- Post-capture quality check (M11 Part B) ---------------------------
  // Runs the pure client-side checks on the still BEFORE OCR. Pass -> scan with
  // no friction. Fail -> a large, spoken, icon-led suggestion naming the ONE
  // biggest problem, with Retake (primary) and Use anyway. "Use anyway" ALWAYS
  // proceeds — a farmer in a hurry (or a photo our heuristic misjudges) is never
  // locked out; the worst case is the conservative UNCONFIRMED default.
  const Q_ICON = { blur: "🌀", dark: "🔅", bright: "☀️", far: "🔍" };
  const Q_TITLE = { blur: "quality.blurry_title", dark: "quality.dark_title", bright: "quality.bright_title", far: "quality.far_title" };
  const Q_TIP = { blur: "quality.blurry_tip", dark: "quality.dark_tip", bright: "quality.bright_tip", far: "quality.far_tip" };

  function assessThenScan(dataURL) {
    state.lastPhoto = dataURL; // kept for the CONFIRM transparency thumbnail (Part C)
    qualityAssess(dataURL).then((res) => {
      state.lastQuality = res ? res.signals : null;
      if (!res || res.pass) return proceedScan(dataURL);
      showQualitySuggestion(res.problem, dataURL);
    });
  }
  // Load, downscale to ~200px, assess. Never throws — on any failure we simply
  // proceed to the scan (a quality check must never block).
  function qualityAssess(dataURL) {
    return new Promise((resolve) => {
      if (!window.Quality) return resolve(null);
      const im = new Image();
      im.onload = () => {
        try {
          const w = 200, h = Math.max(1, Math.round(im.height * (w / im.width)));
          sampleCanvas.width = w; sampleCanvas.height = h;
          const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, w, h);
          resolve(window.Quality.assess(ctx.getImageData(0, 0, w, h)));
        } catch { resolve(null); }
      };
      im.onerror = () => resolve(null);
      im.src = dataURL;
    });
  }
  function proceedScan(dataURL) { runScan(dataURL); }

  function showQualitySuggestion(problem, dataURL) {
    state.quality = state.quality || { retakes: 0, useAnyway: 0 };
    const root = $("#qualityRoot");
    root.innerHTML = "";
    root.appendChild(el("div", "q-icon", Q_ICON[problem] || "📷"));
    root.appendChild(el("h2", "q-title", esc(t(Q_TITLE[problem] || "quality.blurry_title"))));
    root.appendChild(el("p", "q-tip", esc(t(Q_TIP[problem] || "quality.blurry_tip"))));
    const thumb = el("img", "q-thumb"); thumb.src = dataURL; thumb.alt = ""; root.appendChild(thumb);
    const actions = el("div", "q-actions");
    const retake = el("button", "btn btn-primary btn-block", "📷 " + esc(t("ui.retake")));
    retake.onclick = () => { state.quality.retakes++; openCamera(true); };
    const useAny = el("button", "btn btn-replay btn-block", esc(t("ui.use_anyway")));
    useAny.onclick = () => { state.quality.useAnyway++; proceedScan(dataURL); };
    actions.append(retake, useAny);
    root.appendChild(actions);
    show("quality");
    speakSeq([{ key: "q_title", text: t(Q_TITLE[problem]) }, { key: "q_tip", text: t(Q_TIP[problem]) }]);
  }

  // ---- Emergency: one-tap, offline poison-control flow -------------------
  // Load the emergency bundle: memory -> localStorage -> opportunistic network.
  // Never blocks the UI (emergency must open instantly with no network call).
  async function loadEmergencyBundle() {
    if (!state.bundle) {
      const cached = localStorage.getItem("mg_emergency_bundle");
      if (cached) { try { state.bundle = JSON.parse(cached); } catch {} }
    }
    // Opportunistic refresh — attempt via net.js (decided by outcome); failure
    // offline is silent (we already have cache or the embedded fallback).
    window.Net.requestJSON(`/api/emergency-bundle?lang=${state.lang}`)
      .then((r) => { if (r.online && r.ok && r.data && r.data.first_aid) { state.bundle = r.data; localStorage.setItem("mg_emergency_bundle", JSON.stringify(r.data)); } })
      .catch(() => {});
    return state.bundle;
  }

  function emgHeader() {
    const h = el("div", "emg-header");
    h.innerHTML = `<span class="emg-mark" aria-hidden="true">🆘</span><h1 class="emg-title">${esc(t("ui.emergency_title"))}</h1>`;
    return h;
  }

  function emgCallActions() {
    const wrap = el("div", "emg-actions");
    const agent = state.bundle && state.bundle.agents && state.bundle.agents[0];
    const poison = state.bundle && state.bundle.poison_centre;
    const phone = (agent && agent.phone) || poison || "";
    const call = el("a", "btn emg-call btn-block");
    call.href = phone ? `tel:${String(phone).replace(/\s/g, "")}` : "#";
    call.innerHTML = `☎ ${esc(t("emergency.call_help"))}` +
      (agent ? `<small>${esc(t("emergency.call_agent"))}: ${esc(agent.name || "")} ${esc(agent.phone || "")}</small>` : "") +
      (poison ? `<small>${esc(t("emergency.poison_centre"))}: ${esc(poison)}</small>` : "");
    call.onclick = () => speak({ key: "emergency_call_help", text: t("emergency.call_help") });
    wrap.appendChild(call);
    const back = el("button", "ghost-btn wide emg-back", "✕ " + esc(t("ui.back")));
    back.onclick = () => show("home");
    wrap.appendChild(back);
    return wrap;
  }

  // Optional, never-blocking product context: auto-uses the session product,
  // offers recent scans, and a "general first-aid" (no product) choice.
  function emgProductContext() {
    const wrap = el("div");
    const line = el("div", "firstaid-for");
    if (state.emergencyProduct) {
      const rec = state.bundle && state.bundle.first_aid && state.bundle.first_aid[state.emergencyProduct];
      line.textContent = `${t("emergency.for_product")}: ${(rec && rec.product_name) || state.emergencyProduct}`;
    } else {
      line.textContent = t("emergency.universal_note");
    }
    wrap.appendChild(line);

    const chips = el("div", "emg-chips");
    const gen = el("button", "btn btn-replay emg-chip", esc(t("emergency.no_product")));
    gen.onclick = () => { state.emergencyProduct = null; renderRouteChooser(); };
    chips.appendChild(gen);
    state.recent.slice(0, 3).forEach((r) => {
      const c = el("button", "btn btn-replay emg-chip", esc(r.product_name || r.activeIngredient));
      c.onclick = () => { state.emergencyProduct = r.activeIngredient; renderRouteChooser(); };
      chips.appendChild(c);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  function renderRouteChooser() {
    const root = $("#emergencyRoot");
    root.innerHTML = "";
    root.appendChild(emgHeader());
    root.appendChild(el("p", "emg-prompt", esc(t("emergency.choose_route"))));
    root.appendChild(emgProductContext());

    const grid = el("div", "route-grid");
    ["skin", "eyes", "swallowed", "breathed"].forEach((route) => {
      const b = el("button", "route-btn");
      b.innerHTML = `<span class="route-emoji" aria-hidden="true">${ROUTE_EMOJI[route]}</span><span class="route-name">${esc(t("route." + route))}</span>`;
      b.onclick = () => renderFirstAid(route);
      const speakRoute = () => speak({ key: "route_" + route, text: t("route." + route) });
      b.addEventListener("focus", speakRoute);        // spoken on focus
      b.addEventListener("pointerenter", speakRoute);
      grid.appendChild(b);
    });
    root.appendChild(grid);
    root.appendChild(emgCallActions());
  }

  function renderFirstAid(route) {
    // SINGLE rendering path. Steps are ALWAYS aid_* codes — product-specific if
    // the product covers this route, else the universal fallback. There is no
    // free-text branch. Each code -> localized text (aid.*) + recorded clip, so
    // product and universal first-aid are voiced + localized identically.
    const bundle = state.bundle;
    const ing = state.emergencyProduct;
    const rec = ing && bundle && bundle.first_aid && bundle.first_aid[ing];
    const productCodes = rec && rec.routes && Array.isArray(rec.routes[route]) ? rec.routes[route] : null;
    const isProduct = Boolean(productCodes && productCodes.length);
    // Universal fallback: bundle's copy when cached, else the embedded constant
    // (so the emergency path works even with an empty cache).
    const universal = (bundle && bundle.universal) || ROUTE_UNIVERSAL_STEPS;
    const codes = isProduct ? productCodes : (universal[route] || ROUTE_UNIVERSAL_STEPS[route] || []);
    const forName = isProduct ? (rec.product_name || ing) : null;
    const steps = codes.map((key) => ({ key, text: t("aid." + key) }));

    const root = $("#emergencyRoot");
    root.innerHTML = "";
    root.appendChild(emgHeader());
    const forLine = el("div", "firstaid-for");
    forLine.textContent = (isProduct && forName
      ? `${t("emergency.for_product")}: ${forName}`
      : t("emergency.universal_note")) + ` · ${t("route." + route)}`;
    root.appendChild(forLine);

    const card = el("div", "step-card");
    root.appendChild(card);
    let i = 0;
    function paintStep() {
      card.innerHTML =
        `<div><span class="step-num">${i + 1}</span><span class="step-count">${esc(t("emergency.step"))} ${i + 1}/${steps.length}</span></div>` +
        `<div class="step-text">${esc(steps[i].text)}</div>`;
      const next = el("button", "btn btn-danger btn-block step-next",
        i < steps.length - 1 ? "▶ " + esc(t("emergency.next")) : "✓ " + esc(t("emergency.done")));
      next.onclick = () => { if (i < steps.length - 1) { i++; paintStep(); } else { renderRouteChooser(); } };
      card.appendChild(next);
      // Auto-play: "stay calm" intro on the first step, then the step clip.
      const items = i === 0 ? [{ key: "emergency_stay_calm" }] : [];
      items.push({ key: steps[i].key, text: steps[i].text });
      speakSeq(items);
    }
    paintStep();
    root.appendChild(emgCallActions());
  }

  // One tap from anywhere: open instantly, no network, no spinner.
  function openEmergency() {
    state.emergencyProduct = state.session ? state.session.activeIngredient : null;
    show("emergency");
    renderRouteChooser();
    loadEmergencyBundle(); // async, non-blocking (offline uses cache/embedded)
    speakSeq([
      { key: "emergency_title", text: t("ui.emergency_title") },
      { key: "emergency_ask_route", text: t("emergency.choose_route") },
    ]);
  }

  // ---- Wire up -----------------------------------------------------------
  function bind() {
    // Hero: one tap from the front door to the scan screen. Never a gate.
    $("#heroScanBtn").onclick = () => show("scan");
    $("#skipIntro").onclick = () => {
      if (homeSkipOn()) { localStorage.setItem("mg_home_skip", "false"); paintSkipIntro(); }
      else { localStorage.setItem("mg_home_skip", "true"); paintSkipIntro(); show("scan"); }
    };
    $("#scanBtn").onclick = () => {
      if (state.geoConsent == null) { $("#geoSheet").hidden = false; }
      else openCamera();
    };
    $("#captureBtn").onclick = capture;
    $("#fileInput").onchange = onFile;
    $("#langBtn").onclick = async () => { await buildLangList(); $("#langSheet").hidden = false; };
    $("#langSheet").onclick = (e) => { if (e.target.id === "langSheet") e.target.hidden = true; };
    $("#sosBtn").onclick = openEmergency;
    $("#geoAllow").onclick = () => { state.geoConsent = "yes"; localStorage.setItem("mg_geo", "yes"); $("#geoSheet").hidden = true; openCamera(); };
    $("#geoSkip").onclick = () => { state.geoConsent = "no"; localStorage.setItem("mg_geo", "no"); $("#geoSheet").hidden = true; openCamera(); };
    document.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => show(b.dataset.nav)));
  }

  // Expose a tiny surface for automated verification (not used by the UI).
  window.MG = {
    renderResult, selectLang, getState: () => state, t,
    scanBase64: runScan, openEmergency, renderFirstAid, renderRouteChooser,
    audio: () => window.AudioLayer, lastSpoken: () => window.__mgAudio,
    verifyOfflineAndRender, prepareOffline,   // M6 offline verification hooks
    assessThenScan, showQualitySuggestion,    // M11 quality-check verification hooks
  };

  // Staging posture (M8 Part D): a clear, NON-DISMISSIBLE "demonstration" banner
  // whenever the server reports STAGING=true. Cached in localStorage so it also
  // shows on later offline loads. There is no close button — it cannot be
  // dismissed; this is a demonstration, not a live safety service.
  async function applyStagingPosture() {
    let staging = localStorage.getItem("mg_staging") === "true";
    try {
      const r = await window.Net.requestJSON("/api/app-config");
      if (r.online && r.ok && r.data) {
        staging = Boolean(r.data.staging);
        localStorage.setItem("mg_staging", String(staging));
      }
    } catch { /* offline -> use the cached value */ }
    if (staging) mountStagingBanner(); else unmountStagingBanner();
  }
  function mountStagingBanner() {
    if ($("#stagingBanner")) return;
    const b = el("div", "staging-banner");
    b.id = "stagingBanner";
    b.setAttribute("role", "alert");
    b.innerHTML = `<span aria-hidden="true">⚠</span> <span>${esc(t("ui.staging_notice"))}</span>`;
    document.body.insertBefore(b, document.body.firstChild); // above the topbar, normal flow
  }
  function unmountStagingBanner() {
    const b = $("#stagingBanner"); if (b) b.remove();
  }

  // Insert the language-offer banner container under the top bar.
  function mountLangBanner() {
    if ($("#langBanner")) return;
    const banner = el("div", "lang-banner");
    banner.id = "langBanner";
    banner.hidden = true;
    document.querySelector(".topbar").insertAdjacentElement("afterend", banner);
  }

  async function init() {
    bind();
    applyStagingPosture(); // show the demonstration banner if the server is STAGING
    mountLangBanner();
    mountOfflineChip();
    await ensureLangMeta();
    // A stored language that isn't complete must not silently show as if it works.
    // Display English and offer the choice (do not pick for the farmer).
    if (!isLangComplete(state.lang)) {
      const requested = state.lang;
      state.lang = "en";
      await loadLang("en");
      paintChrome();
      showLangOffer(requested); // banner only on load — no re-announce, no re-log
    } else {
      await loadLang(state.lang);
      paintChrome();
    }
    // Returning-visitor path (M9): a user who chose "skip" lands on the scan
    // screen in zero taps. The homepage is a front door, never a gate.
    if (homeSkipOn()) show("scan");
    window.AudioLayer.loadManifest();
    loadEmergencyBundle(); // prefetch + cache the offline emergency data
    ensureDeviceToken();   // obtain the app-issued write token (M7.5) in the background
    prepareOffline();      // background registry download (M6) — never blocks UI
    flushQueue();          // flush any offline scans queued from a prior session
    if ("serviceWorker" in navigator) {
      // Register right away — gating on window 'load' can miss it when the
      // shell is tiny/cached and 'load' has already fired.
      navigator.serviceWorker.register("/sw.js").catch((e) => console.info("SW register failed:", e));
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
