import { config } from "./config.js";

// ---------------------------------------------------------------------------
// BATCH ANOMALY HEURISTICS (M7.5 Part C) — the fingerprint of surveillance
// poisoning. Genuine farmer scans do NOT arrive as synchronized bursts of
// made-up registration numbers; a poisoning script does. These are COARSE
// filters, not fraud AI. A sync call is one source's burst (Part B rate-limits
// per token + per IP), so the batch itself is the window — we deliberately do
// not store a source id on rows (anonymity, SAFETY.md), so cross-batch
// correlation is out of scope by design.
//
// Pure function -> Node-testable. Fails conservative: any trigger quarantines.
// ---------------------------------------------------------------------------

const normalizeRegNo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function longestCommonPrefix(strings) {
  if (!strings.length) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

// Trailing integer of a normalized reg-no ("ETHFUN014217" -> 14217), or null.
function trailingInt(norm) {
  const m = /(\d+)$/.exec(norm);
  return m ? Number(m[1]) : null;
}

// Are the flagged reg-numbers a consecutive run (invented sequentially)?
function isSequential(norms, min) {
  const ints = norms.map(trailingInt).filter((n) => n != null).sort((a, b) => a - b);
  if (ints.length < min) return false;
  const uniq = [...new Set(ints)];
  if (uniq.length < min) return false;
  for (let i = 1; i < uniq.length; i++) if (uniq[i] !== uniq[i - 1] + 1) return false;
  return true;
}

// Do all flagged coordinates fall inside a tight bounding box?
function isTightlyClustered(flagged, span) {
  const pts = flagged.filter((f) => typeof f.lat === "number" && typeof f.lon === "number");
  if (pts.length < flagged.length || pts.length === 0) return false; // need coords on all
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  return (Math.max(...lats) - Math.min(...lats)) <= span && (Math.max(...lons) - Math.min(...lons)) <= span;
}

/**
 * @param {Array<{regNoRead:string, lat?:number, lon?:number}>} flagged  scans in this
 *   batch whose authoritative re-verify was UNREGISTERED/BANNED
 * @returns {{quarantine:boolean, reason:string|null}}
 */
export function evaluateBatchAnomaly(flagged, cfg = config.surveillance) {
  const n = (flagged || []).length;
  if (n === 0) return { quarantine: false, reason: null };

  // 1. Volume: many flagged scans from one source in one burst.
  if (n >= cfg.quarantineFlagBurst) return { quarantine: true, reason: "flag_burst" };

  if (n >= cfg.quarantineUniformMin) {
    const norms = flagged.map((f) => normalizeRegNo(f.regNoRead)).filter(Boolean);
    // 2. Uniform invented numbers: a long shared prefix across the flagged set.
    if (norms.length >= cfg.quarantineUniformMin &&
        longestCommonPrefix(norms).length >= cfg.quarantinePrefixLen) {
      return { quarantine: true, reason: "uniform_regnos" };
    }
    // 3. Sequential invented numbers.
    if (isSequential(norms, cfg.quarantineUniformMin)) {
      return { quarantine: true, reason: "sequential_regnos" };
    }
    // 4. Tight spatial cluster of flagged scans from a single source.
    if (isTightlyClustered(flagged, cfg.quarantineClusterSpan)) {
      return { quarantine: true, reason: "clustered_flags" };
    }
  }
  return { quarantine: false, reason: null };
}
