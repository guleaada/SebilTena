// M11 Part B — scan-quality pure-function tests. The blur / exposure / edge /
// assess functions are pure (they take an ImageData-shaped object), so we test
// them directly against synthetic images — no browser. Deterministic.
//
//   node scripts/test-quality.js
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
new Function("window", fs.readFileSync(path.join(ROOT, "public", "js", "quality.js"), "utf8"))(win);
const Q = win.Quality;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

// Build an ImageData-shaped grayscale image from a per-pixel function.
function mk(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y), i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

// Fixtures:
const sharpGood = mk(80, 80, (x, y) => ((x + y) % 2 ? 168 : 96)); // fine texture, mid exposure
const blurry = mk(80, 80, (x) => 100 + Math.round((x / 80) * 40)); // smooth ramp -> low Laplacian variance
const darkSharp = mk(80, 80, (x, y) => ((x + y) % 2 ? 44 : 8));   // sharp but dark
const brightSharp = mk(80, 80, (x, y) => ((x + y) % 2 ? 255 : 250)); // blown out (glare)
const flat = mk(80, 80, () => 128);
// A well-exposed WHITE label: light background (~240) with dark text. Common in
// the real world — it must PASS, not read as "too bright".
const whiteLabel = mk(80, 80, (x, y) => ((x % 8 < 3 && y % 6 < 4) ? 25 : 240));
// Sharp but SPARSE detail: flat mid-grey with a tiny high-contrast corner.
const farSparse = mk(120, 120, (x, y) => (x < 12 && y < 12 && ((x + y) % 2)) ? 255 : (x < 12 && y < 12 ? 0 : 128));

async function main() {
  console.log("blurScore — sharp >> blurry");
  const bSharp = Q.blurScore(sharpGood), bBlur = Q.blurScore(blurry);
  check("sharp image has high focus score", bSharp > Q.DEFAULTS.blurThreshold, String(Math.round(bSharp)));
  check("smooth/blurry image has low focus score", bBlur < Q.DEFAULTS.blurThreshold, String(Math.round(bBlur)));

  console.log("\nexposure — dark / bright / ok");
  check("dark image -> dark", Q.exposure(darkSharp).verdict === "dark", JSON.stringify(Q.exposure(darkSharp)));
  check("blown-out image -> bright", Q.exposure(brightSharp).verdict === "bright", JSON.stringify(Q.exposure(brightSharp)));
  check("well-exposed image -> ok", Q.exposure(sharpGood).verdict === "ok", JSON.stringify(Q.exposure(sharpGood)));
  // Real-world guard: a well-lit WHITE label must not read as "too bright".
  check("well-exposed WHITE label -> ok (not falsely 'bright')", Q.exposure(whiteLabel).verdict === "ok", JSON.stringify(Q.exposure(whiteLabel)));
  check("WHITE label passes assess (no false problem)", Q.assess(whiteLabel).pass === true, JSON.stringify(Q.assess(whiteLabel)));

  console.log("\nedgeDensity — texture vs flat");
  check("textured image has edges", Q.edgeDensity(sharpGood) > Q.DEFAULTS.minEdgeDensity);
  check("flat image has ~no edges", Q.edgeDensity(flat) < Q.DEFAULTS.minEdgeDensity, String(Q.edgeDensity(flat)));

  console.log("\nassess — reports the ONE biggest problem, blur -> exposure -> size");
  const good = Q.assess(sharpGood);
  check("good photo passes with no problem", good.pass === true && good.problem === null, JSON.stringify(good));
  check("blurry photo -> 'blur'", Q.assess(blurry).problem === "blur", JSON.stringify(Q.assess(blurry)));
  check("dark (but sharp) photo -> 'dark'", Q.assess(darkSharp).problem === "dark", JSON.stringify(Q.assess(darkSharp)));
  check("bright (but sharp) photo -> 'bright'", Q.assess(brightSharp).problem === "bright", JSON.stringify(Q.assess(brightSharp)));
  const far = Q.assess(farSparse);
  check("sharp+exposed but sparse-detail photo -> 'far'", far.problem === "far", JSON.stringify(far));

  console.log("\nsignals are always returned (for tips + tuning logs)");
  const s = Q.assess(blurry).signals;
  check("signals carry blur + exposure + mean + edgeDensity", typeof s.blur === "number" && "exposure" in s && "mean" in s && "edgeDensity" in s, JSON.stringify(s));
  check("signals contain no image data (anonymized)", !("data" in s) && !("image" in s));

  console.log("\nlive light hint");
  check("dark mean -> 'dark'", Q.lightHint(20) === "dark");
  check("bright mean -> 'bright'", Q.lightHint(230) === "bright");
  check("mid mean -> 'ok'", Q.lightHint(128) === "ok");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
