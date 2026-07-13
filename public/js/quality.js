/* ==========================================================================
   SCAN QUALITY (M11) — pure, client-side image analysis to help a farmer take a
   readable photo BEFORE OCR runs. This module NEVER touches the verdict, the
   matcher, or any safety rule: a quality check can only DELAY a scan for a better
   photo, never block it (a determined user's "Use anyway" always proceeds, and a
   bad photo still safely resolves to UNCONFIRMED downstream).

   Every function is pure — it takes an ImageData-shaped { data, width, height }
   (RGBA) and returns numbers/verdicts — so the thresholds are unit-tested in Node
   against synthetic images (scripts/test-quality.js). Thresholds are PROVISIONAL,
   to be tuned against real Ethiopian label photos during the pilot. See
   DECISIONS.md.
   ========================================================================== */
window.Quality = (() => {
  "use strict";

  // Provisional thresholds (tune against real photos). All operate on a small
  // downscaled grayscale copy (~200px wide) — cheap on a low-end phone.
  const DEFAULTS = {
    blurThreshold: 55,     // variance-of-Laplacian below this = blurry
    clipDark: 26, clipBright: 248, // per-pixel luminance clipping bounds
    darkMean: 52, brightMean: 235, // whole-frame mean luminance bounds
    // Bright is tuned CONSERVATIVELY: real pesticide labels are usually
    // white/light, and a well-exposed white label must NOT read as "too bright".
    // Only genuine glare / blow-out (lots of near-pure-white clipping, or an
    // extreme overall mean) trips it. Dark can be stricter — an underexposed
    // photo is genuinely hard to read.
    darkFrac: 0.62, brightFrac: 0.55, // fraction of clipped pixels that flags exposure
    minEdgeDensity: 0.018, // fraction of strong-gradient pixels; below = too far / no label
    liveDark: 58, liveBright: 216, // live-preview mean-luminance hint bounds
  };

  // Rec.601 luminance of RGBA pixel at byte offset i.
  const lumAt = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  // Grayscale Float64 plane from an ImageData-shaped object.
  function grayPlane(img) {
    const d = img.data, n = img.width * img.height, g = new Float64Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) g[p] = lumAt(d, i);
    return g;
  }

  /** Mean luminance 0..255 (used for the live light hint). */
  function meanLuminance(img) {
    const d = img.data; let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += lumAt(d, i); n++; }
    return n ? sum / n : 0;
  }

  /** Live-preview light hint from a sampled mean: 'dark' | 'bright' | 'ok'. */
  function lightHint(mean, cfg = DEFAULTS) {
    if (mean < cfg.liveDark) return "dark";
    if (mean > cfg.liveBright) return "bright";
    return "ok";
  }

  /** Exposure verdict from a histogram pass: { verdict:'dark'|'bright'|'ok', mean, darkFrac, brightFrac }. */
  function exposure(img, cfg = DEFAULTS) {
    const d = img.data; let sum = 0, dark = 0, bright = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = lumAt(d, i); sum += L; n++;
      if (L <= cfg.clipDark) dark++; else if (L >= cfg.clipBright) bright++;
    }
    const mean = n ? sum / n : 0, darkFrac = n ? dark / n : 0, brightFrac = n ? bright / n : 0;
    let verdict = "ok";
    if (mean < cfg.darkMean || darkFrac > cfg.darkFrac) verdict = "dark";
    else if (mean > cfg.brightMean || brightFrac > cfg.brightFrac) verdict = "bright";
    return { verdict, mean: Math.round(mean), darkFrac: +darkFrac.toFixed(3), brightFrac: +brightFrac.toFixed(3) };
  }

  /** Focus sharpness = variance of the 4-neighbour Laplacian (higher = sharper). */
  function blurScore(img) {
    const g = grayPlane(img), w = img.width, h = img.height;
    if (w < 3 || h < 3) return 0;
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const L = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += L; sumSq += L * L; n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return Math.max(0, sumSq / n - mean * mean); // variance
  }

  /** Fraction of pixels whose gradient magnitude is strong — proxy for "there is
   *  text/detail". Uses ADJACENT differences (not central) so fine, high-frequency
   *  text edges aren't cancelled out. */
  function edgeDensity(img, cfg = DEFAULTS) {
    const g = grayPlane(img), w = img.width, h = img.height;
    if (w < 2 || h < 2) return 0;
    let strong = 0, n = 0;
    const thr = 28; // gradient magnitude threshold (provisional)
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const gx = g[i + 1] - g[i], gy = g[i + w] - g[i];
        if (Math.abs(gx) + Math.abs(gy) > thr) strong++;
        n++;
      }
    }
    return n ? strong / n : 0;
  }

  /**
   * Assess a downscaled still. Reports the ONE biggest problem in priority order
   * (blur -> exposure -> size), plus the raw signals (for tips + tuning logs).
   * @returns {{pass:boolean, problem:null|'blur'|'dark'|'bright'|'far', signals:object}}
   */
  function assess(img, cfg = DEFAULTS) {
    const blur = blurScore(img);
    const exp = exposure(img, cfg);
    const edges = edgeDensity(img, cfg);
    const signals = { blur: Math.round(blur), exposure: exp.verdict, mean: exp.mean, edgeDensity: +edges.toFixed(4) };

    let problem = null;
    if (blur < cfg.blurThreshold) problem = "blur";
    else if (exp.verdict === "dark") problem = "dark";
    else if (exp.verdict === "bright") problem = "bright";
    else if (edges < cfg.minEdgeDensity) problem = "far";
    return { pass: problem === null, problem, signals };
  }

  return { DEFAULTS, meanLuminance, lightHint, exposure, blurScore, edgeDensity, assess };
})();
