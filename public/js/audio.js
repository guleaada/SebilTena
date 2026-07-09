/* ==========================================================================
   MedaGuard audio layer — pre-recorded clips first, TTS bridge second, silent
   fallback last. This is the ONLY place in the app allowed to touch
   speechSynthesis. See DECISIONS.md (audio architecture).

   Why clips, not synthesis: none of the six Ethiopian languages resolve a
   reliable Web Speech voice. Every safety-critical phrase is from a small fixed
   set, recorded once per language by native speakers and shipped as static
   files. Perfect pronunciation, full offline, zero API cost, and it covers
   Afar / Tigrinya, which have poor or no commercial TTS coverage. English is the
   exception: it resolves via the Web Speech TTS bridge and needs no recordings.

   speak(item, lang)          -> plays one clip (item = "key" or {key, text})
   speakSequence(items, lang) -> plays clips back-to-back (e.g. first-aid steps)
   stopSpeaking()
   isAudioAvailable(lang)     -> true if any clips exist for that language
   speakNumber(n, lang, opts) -> composes a number from atomic clips
   ========================================================================== */
window.AudioLayer = (() => {
  "use strict";

  const DEBUG = false; // flip on to log which resolution path fired
  const VOICE_HINTS = {
    am: ["am"], om: ["om"], ti: ["ti"], so: ["so"], aa: ["aa"],
    en: ["en-us", "en-gb", "en"],
  };

  let manifest = { format: "mp3", formats: {}, languages: {} };
  let manifestLoaded = false;
  let current = null;   // current HTMLAudioElement
  let token = 0;        // cancellation token for sequences

  // Warm the TTS voice list once (some browsers populate it lazily). This is the
  // only speechSynthesis touch-point in the whole app.
  if ("speechSynthesis" in window) {
    try {
      speechSynthesis.getVoices();
      speechSynthesis.onvoiceschanged = () => { /* voices now available */ };
    } catch { /* ignore */ }
  }

  async function loadManifest() {
    if (manifestLoaded) return manifest;
    try {
      manifest = await fetch("/audio/manifest.json").then((r) => r.json());
    } catch {
      manifest = { format: "mp3", formats: {}, languages: {} };
    }
    manifestLoaded = true;
    return manifest;
  }

  const clipsFor = (lang) => (manifest.languages && manifest.languages[lang]) || [];
  const isAudioAvailable = (lang) => clipsFor(lang).length > 0;
  const hasClip = (lang, key) => clipsFor(lang).includes(key);
  function clipUrl(lang, key) {
    const fmt = (manifest.formats && manifest.formats[lang]) || manifest.format || "mp3";
    return `/audio/${lang}/${encodeURIComponent(key)}.${fmt}`;
  }

  function ttsVoice(lang) {
    if (!("speechSynthesis" in window)) return null;
    const voices = speechSynthesis.getVoices() || [];
    for (const h of VOICE_HINTS[lang] || []) {
      const v = voices.find((vc) => (vc.lang || "").toLowerCase().replace("_", "-").startsWith(h));
      if (v) return v;
    }
    return null;
  }

  function log(path, key, lang) {
    window.__mgAudio = { path, key, lang, at: Date.now() };
    if (DEBUG) console.info(`[audio] ${lang}:${key} -> ${path}`);
  }

  function playClip(url) {
    return new Promise((resolve) => {
      const a = new Audio(url);
      current = a;
      a.onended = () => resolve(true);
      a.onerror = () => resolve(false);
      a.play().catch(() => resolve(false));
    });
  }

  function ttsSpeak(text, voice) {
    return new Promise((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = 0.95;
        u.onend = () => resolve(true);
        u.onerror = () => resolve(true);
        speechSynthesis.speak(u);
      } catch {
        resolve(false);
      }
    });
  }

  // Resolve ONE item: recorded clip -> TTS bridge -> silent.
  async function speakOne(item, lang, myToken) {
    await loadManifest();
    if (myToken !== token) return "cancelled";
    const key = typeof item === "string" ? item : item.key;
    const text = typeof item === "object" ? item.text : undefined;

    if (key && hasClip(lang, key)) {
      const ok = await playClip(clipUrl(lang, key));
      if (myToken !== token) return "cancelled";
      if (ok) { log("clip", key, lang); return "clip"; }
    }
    // Bridge: Web Speech for languages that have a voice (English/dev mainly).
    const voice = ttsVoice(lang);
    const speakText = text || key;
    if (voice && speakText) {
      log("tts", key, lang);
      await ttsSpeak(speakText, voice);
      return "tts";
    }
    // Silent: keep icon + colour + text on screen. Never garble, never crash.
    log("silent", key, lang);
    return "silent";
  }

  function stopSpeaking() {
    token++;
    if (current) { try { current.pause(); } catch {} current = null; }
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
  }

  async function speak(item, lang) {
    stopSpeaking();
    const myToken = token;
    return speakOne(item, lang, myToken);
  }

  async function speakSequence(items, lang) {
    stopSpeaking();
    const myToken = token;
    const paths = [];
    for (const it of items || []) {
      if (myToken !== token) break;
      paths.push(await speakOne(it, lang, myToken));
    }
    return paths;
  }

  // Atomic clips exist for 0-20 and the tens (30..100); 21-99 are composed
  // tens + ones (e.g. 45 -> num_40, num_5), matching the recording script.
  function integerItems(int) {
    if (int <= 20 || int === 30 || int === 40 || int === 50 || int === 60 ||
        int === 70 || int === 80 || int === 90 || int === 100) {
      return [{ key: `num_${int}`, text: String(int) }];
    }
    if (int < 100) {
      const tens = Math.floor(int / 10) * 10;
      const ones = int % 10;
      const arr = [{ key: `num_${tens}`, text: String(tens) }];
      if (ones) arr.push({ key: `num_${ones}`, text: String(ones) });
      return arr;
    }
    return [{ key: `num_${int}`, text: String(int) }]; // >100: no clip -> TTS/text
  }

  // Compose a number (integer + one decimal place) from atomic clips.
  // e.g. speakNumber(2.5) -> [dose_is?, num_2, point, num_5, unit?]
  function numberItems(n, opts = {}) {
    const items = [];
    if (opts.prefixKey) items.push({ key: opts.prefixKey, text: opts.prefixText });
    const abs = Math.abs(Number(n) || 0);
    const int = Math.trunc(abs);
    const frac = Math.round((abs - int) * 10); // one decimal place
    items.push(...integerItems(int));
    if (frac > 0) {
      items.push({ key: "point", text: "point" });
      items.push({ key: `num_${frac}`, text: String(frac) });
    }
    if (opts.unitKey || opts.unitText) items.push({ key: opts.unitKey, text: opts.unitText });
    return items;
  }
  function speakNumber(n, lang, opts = {}) {
    return speakSequence(numberItems(n, opts), lang);
  }

  return {
    loadManifest,
    isAudioAvailable,
    speak,
    speakSequence,
    stopSpeaking,
    speakNumber,
    numberItems,   // exposed for tests
    _clipsFor: clipsFor,
  };
})();
