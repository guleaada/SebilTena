/* ==========================================================================
   MedaGuard PWA — vanilla, no framework (see DECISIONS.md for the why).
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
    UNCONFIRMED:  { tone: "caution", symbol: "?" },
    UNREGISTERED: { tone: "danger",  symbol: "!" },
    BANNED:       { tone: "danger",  symbol: "⛔" },
    SUSPENDED:    { tone: "danger",  symbol: "⛔" },
  };

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

  // Persistent banner while an incomplete language is active: never let the
  // farmer think they are getting their language when they are seeing English.
  function updateLangBanner() {
    const banner = $("#langBanner");
    if (!banner) return;
    if (isLangComplete(state.lang)) { banner.hidden = true; return; }
    const native = state.langMeta[state.lang]?.native || state.lang;
    banner.textContent = `⚠ ${native} — ${t("ui.lang_coming_soon")}`;
    banner.hidden = false;
  }

  function logLangFallback(lang) {
    try {
      const body = JSON.stringify({ requested: lang, channel: "app" });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/lang-fallback", new Blob([body], { type: "application/json" }));
      else fetch("/api/lang-fallback", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    } catch { /* logging must never break the UI */ }
  }

  async function selectLang(lang) {
    state.lang = lang;
    localStorage.setItem("mg_lang", lang);
    $("#langSheet").hidden = true;
    await ensureLangMeta();
    await loadLang(lang);
    paintChrome();
    updateLangBanner();
    if (!isLangComplete(lang)) {
      // Never silently substitute. Announce in English + log the demand.
      window.AudioLayer.speak({ key: "lang_coming_soon", text: t("ui.lang_coming_soon_spoken") }, "en");
      logLangFallback(lang);
    }
    // Re-render + re-speak whatever is on screen.
    if ($("#view-result").classList.contains("is-active") && state.lastResult) renderResult(state.lastResult);
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function postScan(imageBase64) {
    const body = { imageBase64, lang: state.lang };
    if (state.geoConsent === "yes") {
      const pos = await getPosition().catch(() => null);
      if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
    }
    return api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const verifyNumber = (registrationNo) =>
    api("/api/verify-number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationNo, lang: state.lang }),
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
    speak({ key: "scanning", text: t("ui.reading") });
    if (!navigator.onLine) return renderOffline();
    try {
      const result = await postScan(imageBase64);
      renderResult(result);
    } catch (err) {
      console.warn("scan failed:", err);
      renderOffline();
    }
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
    again.onclick = () => show("home");
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
      addAgentAction(actions);
      addScanAgain(actions);
      $("#verdictCard").replaceChildren(card);
    }

    // Auto-speak the verdict the instant it appears.
    speakSeq(verdictItems(status, headline, message));
  }

  function renderConfirm(res, card, actions) {
    const c = res.candidate || {};
    const ident = el("div", "card");
    ident.innerHTML = `
      <div class="product-head">
        <span class="product-name">${esc(c.product_name || "")}</span>
        <span class="product-meta">${esc(t("ui.active_ingredient"))}: ${esc(c.active_ingredient || "")}</span>
      </div>`;
    const yn = el("div", "yn-row");
    const yes = el("button", "btn btn-yes", "✓ " + esc(t("ui.yes")));
    const no = el("button", "btn btn-no", "✕ " + esc(t("ui.no")));
    yes.onclick = async () => {
      show("loading");
      try {
        const rec = await verifyNumber(res.confirmRegistrationNo);
        renderResult({ status: rec.status, verify: rec });
      } catch { renderOffline(); }
    };
    no.onclick = () => show("home");
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
    try { dose = await getDosage(pesticideId, crop); }
    catch { return renderOffline(); }

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
    b.onclick = () => show("home");
    actions.appendChild(b);
  }
  function addAgentAction(actions) {
    const b = el("button", "btn btn-danger btn-block", "☎ " + esc(t("ui.contact_agent")));
    b.onclick = () => show("emergency"); // agent contact flow arrives with M4/M5
    actions.appendChild(b);
  }

  // ---- Camera ------------------------------------------------------------
  async function openCamera() {
    show("camera");
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
      });
      $("#cam").srcObject = state.stream;
    } catch (err) {
      // Camera blocked/unavailable -> file fallback is always visible anyway.
      console.info("camera unavailable, using file fallback:", err && err.name);
    }
  }
  function stopCamera() {
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  }
  function capture() {
    const video = $("#cam");
    if (!video.videoWidth) { $("#fileInput").click(); return; }
    const canvas = $("#snap");
    const w = 1000, scale = w / video.videoWidth;
    canvas.width = w; canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    runScan(canvas.toDataURL("image/jpeg", 0.7));
  }
  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => runScan(reader.result);
    reader.readAsDataURL(file);
  }

  // ---- Emergency: one-tap, offline poison-control flow -------------------
  // Load the emergency bundle: memory -> localStorage -> opportunistic network.
  // Never blocks the UI (emergency must open instantly with no network call).
  async function loadEmergencyBundle() {
    if (!state.bundle) {
      const cached = localStorage.getItem("mg_emergency_bundle");
      if (cached) { try { state.bundle = JSON.parse(cached); } catch {} }
    }
    if (navigator.onLine) {
      fetch(`/api/emergency-bundle?lang=${state.lang}`)
        .then((r) => r.json())
        .then((b) => { if (b && b.first_aid) { state.bundle = b; localStorage.setItem("mg_emergency_bundle", JSON.stringify(b)); } })
        .catch(() => {});
    }
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
  };

  // Insert the persistent "coming soon — showing English" banner under the top bar.
  function mountLangBanner() {
    if ($("#langBanner")) return;
    const banner = el("div", "lang-banner");
    banner.id = "langBanner";
    banner.hidden = true;
    document.querySelector(".topbar").insertAdjacentElement("afterend", banner);
  }

  async function init() {
    bind();
    mountLangBanner();
    await ensureLangMeta();
    await loadLang(state.lang);
    paintChrome();
    updateLangBanner(); // reflect an incomplete stored language on load
    window.AudioLayer.loadManifest();
    loadEmergencyBundle(); // prefetch + cache the offline emergency data
    if ("serviceWorker" in navigator) {
      // Register right away — gating on window 'load' can miss it when the
      // shell is tiny/cached and 'load' has already fired.
      navigator.serviceWorker.register("/sw.js").catch((e) => console.info("SW register failed:", e));
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
