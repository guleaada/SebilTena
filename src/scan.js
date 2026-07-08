import { db as defaultDb } from "./db.js";
import { verifyNumber as defaultVerify } from "./verify.js";
import { ocrImage as defaultOcr } from "./ocr.js";
import { readLabel as defaultReadLabel } from "../lib/aiClient.js";
import { matchAnchor, buildCandidates, extractRegCandidate } from "./match.js";
import { config } from "./config.js";
import { t, normalizeLang } from "./localize.js";

// ---------------------------------------------------------------------------
// SCAN PIPELINE (Section 3)
//
//   image -> Tesseract OCR -> matchAnchor
//     Tier 1 exact reg-no  -> VERIFIED path (verify.js) — full record + dosage
//     Tier 2 fuzzy name/AI -> CONFIRM — withhold dosage until the farmer confirms
//     Tier 3 miss / weak    -> vision LLM fallback -> matchAnchor again
//                                still miss -> UNREGISTERED / POSSIBLE COUNTERFEIT
//     all providers failed  -> conservative default (UNCONFIRMED)
//
// verify.js remains the ONLY source of dosage/first-aid/PPE. OCR and the vision
// client only ever produce an identity candidate. See SAFETY.md.
// ---------------------------------------------------------------------------

async function loadRegistry(dbClient) {
  const res = await dbClient.execute(
    "SELECT id, registration_no, product_name, active_ingredient FROM pesticides"
  );
  return res.rows.map((r) => ({
    id: r.id,
    registration_no: r.registration_no,
    product_name: r.product_name,
    active_ingredient: r.active_ingredient,
  }));
}

async function logScan(dbClient, row) {
  try {
    await dbClient.execute({
      sql: `INSERT INTO scans
        (registration_no_read, matched_pesticide_id, result_status, confidence,
         lat, lon, region, language, channel)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        row.registration_no_read ?? null,
        row.matched_pesticide_id ?? null,
        row.result_status,
        row.confidence ?? null,
        row.lat ?? null,
        row.lon ?? null,
        row.region ?? null,
        row.language ?? null,
        row.channel ?? "app",
      ],
    });
  } catch (err) {
    // Never let audit logging break the farmer-facing response.
    console.error("scan log failed:", err?.message || err);
  }
}

function candidateFromMatch(match) {
  return {
    registration_no: match.pesticide.registration_no,
    product_name: match.pesticide.product_name,
    active_ingredient: match.pesticide.active_ingredient,
    matchedOn: match.matchedOn,
    score: match.score,
  };
}

/**
 * Run the full scan flow.
 * @param {{imageBase64?:string, ocrTextOverride?:string, lang?:string, lat?:number, lon?:number, region?:string}} input
 * @param {{db?, ocr?, readLabel?, verifyNumber?}} deps  injectable for tests
 */
export async function runScan(input = {}, deps = {}) {
  const dbClient = deps.db ?? defaultDb;
  const ocr = deps.ocr ?? defaultOcr;
  const readLabel = deps.readLabel ?? defaultReadLabel;
  const verify = deps.verifyNumber ?? defaultVerify;

  const language = normalizeLang(input.lang);
  const { imageBase64, lat = null, lon = null, region = null } = input;

  const registry = await loadRegistry(dbClient);

  // --- 1. Tesseract-first (offline-capable) --------------------------------
  let ocrText = input.ocrTextOverride ?? "";
  let ocrConfidence = input.ocrTextOverride != null ? 100 : 0;
  if (input.ocrTextOverride == null && imageBase64) {
    const r = await ocr(imageBase64);
    ocrText = r.text || "";
    ocrConfidence = Number(r.confidence ?? 0);
  }

  const ocrCandidates = buildCandidates(ocrText).all;
  let match = matchAnchor(ocrCandidates, registry);
  let usedVision = false;
  let provider = "tesseract";
  let readRegNo = extractRegCandidate(ocrText);

  // --- 2. Escalate to the vision LLM only on a miss ------------------------
  // A Tier-1/Tier-2 hit from Tesseract is enough — keep the paid call for when
  // OCR can't produce a confident match (Section 3).
  if (match.tier === 3) {
    usedVision = true;
    const read = await readLabel(imageBase64);
    provider = read.provider || "vision-unavailable";
    readRegNo = read.registration_no || readRegNo;

    const gotIdentity = read.registration_no || read.product_name || read.active_ingredient;
    if (read.confidence === "low" || !gotIdentity) {
      // 2b. All providers failed / low -> conservative default. No dosage.
      return conservative(dbClient, { language, lat, lon, region, readRegNo, provider });
    }
    match = matchAnchor(
      [read.registration_no, read.product_name, read.active_ingredient].filter(Boolean),
      registry
    );
  }

  const scanMeta = { language, lat, lon, region, usedVision, provider, ocrConfidence };

  // --- 3a. Tier 1 exact -> VERIFIED (verify.js is the source of truth) ------
  if (match.tier === 1) {
    const verifyResult = await verify(match.pesticide.registration_no, language);
    await logScan(dbClient, {
      registration_no_read: match.pesticide.registration_no,
      matched_pesticide_id: match.pesticide.id,
      result_status: verifyResult.status, // may be VERIFIED / BANNED / EXPIRED / SUSPENDED
      confidence: "high",
      lat, lon, region, language, channel: "app",
    });
    return {
      status: verifyResult.status,
      confidence: "high",
      matchTier: 1,
      registration_no_read: match.pesticide.registration_no,
      matched_pesticide_id: match.pesticide.id,
      needsConfirmation: false,
      verify: verifyResult, // full VERIFIED/BANNED/etc payload incl. dosage from DB
      meta: scanMeta,
    };
  }

  // --- 3b. Tier 2 fuzzy -> CONFIRM. Withhold ALL dosage/PPE/first-aid -------
  if (match.tier === 2) {
    await logScan(dbClient, {
      registration_no_read: readRegNo,
      matched_pesticide_id: match.pesticide.id,
      result_status: "CONFIRM",
      confidence: "medium",
      lat, lon, region, language, channel: "app",
    });
    return {
      status: "CONFIRM",
      confidence: "medium",
      matchTier: 2,
      needsConfirmation: true,
      warningLevel: "warning",
      speak: true,
      registration_no_read: readRegNo,
      matched_pesticide_id: match.pesticide.id,
      // Identity only — NO dosage/safety until the farmer confirms.
      candidate: candidateFromMatch(match),
      headline: t(language, "status.CONFIRM"),
      message: t(language, "msg.confirm"),
      disclaimer: t(language, "disclaimer.official"),
      // To confirm, the client calls POST /api/verify-number with this reg no.
      confirmRegistrationNo: match.pesticide.registration_no,
      meta: scanMeta,
    };
  }

  // --- 3c. Tier 3 miss -> UNREGISTERED / POSSIBLE COUNTERFEIT ---------------
  await logScan(dbClient, {
    registration_no_read: readRegNo,
    matched_pesticide_id: null,
    result_status: "UNREGISTERED",
    confidence: "high",
    lat, lon, region, language, channel: "app",
  });
  return {
    status: "UNREGISTERED",
    confidence: "high",
    matchTier: 3,
    needsConfirmation: false,
    warningLevel: "danger",
    speak: true,
    registration_no_read: readRegNo,
    matched_pesticide_id: null,
    product: null,
    headline: t(language, "status.UNREGISTERED"),
    message: t(language, "msg.unregistered"),
    disclaimer: t(language, "disclaimer.official"),
    meta: scanMeta,
  };
}

async function conservative(dbClient, { language, lat, lon, region, readRegNo, provider }) {
  await logScan(dbClient, {
    registration_no_read: readRegNo,
    matched_pesticide_id: null,
    result_status: "UNCONFIRMED",
    confidence: "low",
    lat, lon, region, language, channel: "app",
  });
  return {
    status: "UNCONFIRMED",
    confidence: "low",
    matchTier: null,
    needsConfirmation: false,
    warningLevel: "danger",
    speak: true,
    registration_no_read: readRegNo,
    matched_pesticide_id: null,
    product: null,
    headline: t(language, "status.UNCONFIRMED"),
    message: t(language, "msg.conservative"),
    disclaimer: t(language, "disclaimer.official"),
    meta: { language, lat, lon, region, usedVision: true, provider },
  };
}
