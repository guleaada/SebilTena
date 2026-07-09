/* ==========================================================================
   MedaGuard PWA — vanilla, no framework (see DECISIONS.md for the why).
   Consumes the existing APIs: /api/scan, /api/verify-number, /api/dosage.
   No dosage/safety value is ever produced on the client — all come from the
   server responses. This file only renders + speaks what the server returns.
   ========================================================================== */
(() => {
  "use strict";

  const LANGS = ["am", "om", "sid", "ti", "so", "wal", "en"];
  const FALLBACK = "en";

  // Dose unit phrases -> atomic clip keys (for the audio number composer).
  const UNIT_KEYS = {
    "kg per hectare": "unit_kg_per_hectare",
    "l per hectare": "unit_l_per_hectare",
    "ml per litre of water": "unit_ml_per_litre",
    "g per litre of water": "unit_g_per_litre",
    kg: "unit_kg", l: "unit_l", ml: "unit_ml", g: "unit_g",
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
    stream: null,
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

  // Verdict/message -> phrase-key items (verdict_* clips exist; msg_* use TTS/text).
  function verdictItems(status, headline, message) {
    const s = String(status || "").toLowerCase();
    const items = [{ key: `verdict_${s}`, text: headline }];
    if (message) items.push({ key: `msg_${s}`, text: message });
    return items;
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
    $("#emgTitle").textContent = t("ui.emergency_title");
    $("#emgText").textContent = t("ui.emergency_soon");
    $("#emgCall").textContent = t("ui.emergency_call_help");
    $("#emgBack").textContent = t("ui.back");
  }

  // ---- Language sheet ----------------------------------------------------
  async function buildLangList() {
    const list = $("#langList");
    list.innerHTML = "";
    const natives = await Promise.all(
      LANGS.map((l) => fetch(`/locales/${l}.json`).then((r) => r.json()).then((d) => d._native || l).catch(() => l))
    );
    LANGS.forEach((l, i) => {
      const b = el("button", "lang-option" + (l === state.lang ? " is-current" : ""), esc(natives[i]));
      b.onclick = () => selectLang(l);
      list.appendChild(b);
    });
  }
  async function selectLang(lang) {
    state.lang = lang;
    localStorage.setItem("mg_lang", lang);
    $("#langSheet").hidden = true;
    await loadLang(lang);
    paintChrome();
    // Re-render + re-speak whatever is on screen.
    if ($("#view-result").classList.contains("is-active") && state.lang) {
      if (state.lastResult) renderResult(state.lastResult);
    }
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
    speak({ key: "reading", text: t("ui.reading") });
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
    speak({ key: "no_connection", text: t("ui.no_connection") });
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
      safetyItems.push({ key: "wear_this", text: t("ui.wear_this") });
      const row = el("div", "ppe-row");
      (safety.ppe_required || []).forEach((p) => {
        const item = el("div", "ppe-item");
        item.innerHTML = `<span class="ppe-emoji">${PPE_EMOJI[p] || "🧰"}</span><span class="ppe-name">${esc(t("ppe." + p))}</span>`;
        row.appendChild(item);
        safetyItems.push({ key: "ppe_" + p, text: t("ppe." + p) });
      });
      sc.appendChild(row);
      if (safety.hazard_class) {
        const hz = safety.hazard_class;
        const band = el("div", `hazard-band hazard-${esc(hz)}`);
        band.innerHTML = `<span>${esc(t("ui.danger_level"))}: ${esc(t("hazard." + hz))}</span><span class="hazard-class-chip">${esc(hz)}</span>`;
        sc.appendChild(band);
        safetyItems.push({ key: "hazard_" + hz, text: `${t("ui.danger_level")}: ${t("hazard." + hz)}` });
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

  // ---- Emergency (minimal in Part A; full poison-control flow in Part B) --
  function openEmergency() {
    show("emergency");
    speak({ key: "emergency_title", text: t("ui.emergency_title") });
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
    scanBase64: runScan, openEmergency,
    audio: () => window.AudioLayer, lastSpoken: () => window.__mgAudio,
  };

  async function init() {
    bind();
    await loadLang(state.lang);
    paintChrome();
    window.AudioLayer.loadManifest();
    if ("serviceWorker" in navigator) {
      // Register right away — gating on window 'load' can miss it when the
      // shell is tiny/cached and 'load' has already fired.
      navigator.serviceWorker.register("/sw.js").catch((e) => console.info("SW register failed:", e));
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
