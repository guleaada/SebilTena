// M2 pipeline tests — exercise every scan path with mocked OCR + mocked vision
// against the real seeded DB. Deterministic, no network, no API keys needed.
//
//   node scripts/test-scan.js
//
import { db, initSchema } from "../src/db.js";
import { runScan, resolveConfirm } from "../src/scan.js";
import { scanStats } from "../src/stats.js";
import { matchAnchor, similarity } from "../src/match.js";
import { readLabel, VISION_PROMPT } from "../lib/aiClient.js";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`);
  }
}

// A vision mock that records whether it was called (to prove the Tesseract
// path never touches the paid LLM).
function visionMock(returnValue) {
  const fn = async () => {
    fn.called = true;
    return returnValue;
  };
  fn.called = false;
  return fn;
}

async function scansCount() {
  const r = await db.execute("SELECT COUNT(*) AS n FROM scans");
  return Number(r.rows[0].n);
}
async function lastScan() {
  const r = await db.execute("SELECT * FROM scans ORDER BY id DESC LIMIT 1");
  return r.rows[0];
}

async function main() {
  await initSchema();

  // ---- T1: exact reg-no in OCR -> VERIFIED, WITHOUT calling vision ---------
  {
    console.log("\nT1 exact reg-no -> VERIFIED (no vision call)");
    const vision = visionMock({ confidence: "low", provider: null });
    const before = await scansCount();
    const res = await runScan(
      {
        ocrTextOverride:
          "Ministry of Agriculture\nMancozeb 80% WP\nReg. No: ETH-FUN-0142/17\nActive: Mancozeb 800 g/kg",
        lang: "am",
      },
      { readLabel: vision }
    );
    check("status VERIFIED", res.status === "VERIFIED", res.status);
    check("matchTier 1", res.matchTier === 1);
    check("vision NOT called", vision.called === false);
    check("has verify payload", !!res.verify);
    check("dosage present + DB-sourced", (res.verify?.dosages?.length ?? 0) > 0);
    check("headline localized (am)", /[ሀ-፿]/.test(res.verify?.headline || ""));
    check("scan row written", (await scansCount()) === before + 1);
    const row = await lastScan();
    check("scan row matched_pesticide_id set", row.matched_pesticide_id != null);
    check("scan row channel app", row.channel === "app");
  }

  // ---- T2: fuzzy name only -> CONFIRM, dosage withheld, no vision ----------
  {
    console.log("\nT2 fuzzy name -> CONFIRM (dosage withheld)");
    const vision = visionMock({ confidence: "low", provider: null });
    const res = await runScan(
      { ocrTextOverride: "MANCOZEB 80% WP\ncontact fungicide\n(reg no worn off)", lang: "en" },
      { readLabel: vision }
    );
    check("status CONFIRM", res.status === "CONFIRM", res.status);
    check("matchTier 2", res.matchTier === 2);
    check("needsConfirmation true", res.needsConfirmation === true);
    check("vision NOT called", vision.called === false);
    check("NO verify payload (dosage withheld)", res.verify === undefined);
    check("no dosages field leaked", res.dosages === undefined);
    check("candidate identity present", !!res.candidate?.product_name);
    check("confirmRegistrationNo provided", !!res.confirmRegistrationNo);
    check("scanId returned for later resolution", Number.isFinite(res.scanId));
  }

  // ---- T2r: resolving a CONFIRM (Part 0.7) ---------------------------------
  {
    console.log("\nT2r resolve CONFIRM (YES / NO / pending exclusion)");
    const vision = visionMock({ confidence: "low", provider: null });
    const mkConfirm = () => runScan(
      { ocrTextOverride: "MANCOZEB 80% WP\ncontact fungicide", lang: "en" },
      { readLabel: vision }
    );
    const rowStatus = async (id) => (await db.execute({ sql: "SELECT result_status, resolved_status FROM scans WHERE id=?", args: [id] })).rows[0];

    // YES -> resolved_status = the verify verdict; full record revealed.
    const c1 = await mkConfirm();
    const yes = await resolveConfirm({ scanId: c1.scanId, confirm: true, registrationNo: c1.confirmRegistrationNo, lang: "en" });
    check("YES returns the verify record", yes.ok && yes.verify?.status === "VERIFIED", JSON.stringify(yes.resolved_status));
    check("YES writes resolved_status = verdict", (await rowStatus(c1.scanId)).resolved_status === "VERIFIED");

    // NO -> REJECTED_BY_USER (a counterfeit-suspicion signal, not null).
    const c2 = await mkConfirm();
    const no = await resolveConfirm({ scanId: c2.scanId, confirm: false, registrationNo: c2.confirmRegistrationNo, lang: "en" });
    check("NO -> REJECTED_BY_USER", no.resolved_status === "REJECTED_BY_USER");
    check("NO writes resolved_status = REJECTED_BY_USER", (await rowStatus(c2.scanId)).resolved_status === "REJECTED_BY_USER");

    // Double-answer is a no-op (already resolved).
    const again = await resolveConfirm({ scanId: c2.scanId, confirm: true, registrationNo: c2.confirmRegistrationNo, lang: "en" });
    check("re-resolving an answered CONFIRM does not change it", again.resolved === false && (await rowStatus(c2.scanId)).resolved_status === "REJECTED_BY_USER");

    // Rate math: pending CONFIRM excluded; REJECTED_BY_USER = counterfeit-suspicion.
    await db.execute("DELETE FROM scans");
    const pending = await mkConfirm();               // stays unresolved
    const s1 = await scanStats(db);
    check("unresolved CONFIRM excluded from resolvedScans", s1.resolvedScans === 0 && s1.unresolvedConfirm === 1, JSON.stringify(s1));
    check("unresolved CONFIRM -> counterfeitRate is 0 (not inflated)", s1.counterfeitRate === 0);

    const rej = await mkConfirm();
    await resolveConfirm({ scanId: rej.scanId, confirm: false, registrationNo: rej.confirmRegistrationNo, lang: "en" });
    const s2 = await scanStats(db);
    check("resolved REJECTED_BY_USER counts as a resolved scan", s2.resolvedScans === 1, JSON.stringify(s2));
    check("REJECTED_BY_USER counts as counterfeit-suspicion", s2.counterfeitSuspicion === 1 && s2.counterfeitRate === 1);
    check("the still-pending CONFIRM is still excluded", s2.unresolvedConfirm === 1);
    void pending;
  }

  // ---- T3a: unknown -> vision reads a fake product -> UNREGISTERED ---------
  {
    console.log("\nT3a unknown, vision reads fake product -> UNREGISTERED");
    const vision = visionMock({
      registration_no: "ZZ-FAKE-999",
      product_name: "MiracleGro Super Booster",
      active_ingredient: "Unknown blend",
      confidence: "high",
      provider: "groq",
    });
    const res = await runScan(
      { ocrTextOverride: "SUPER PLANT BOOSTER XYZ 500", lang: "en" },
      { readLabel: vision }
    );
    check("vision WAS called", vision.called === true);
    check("status UNREGISTERED", res.status === "UNREGISTERED", res.status);
    check("matchTier 3", res.matchTier === 3);
    check("warningLevel danger", res.warningLevel === "danger");
    check("no dosage/verify", res.verify === undefined && res.dosages === undefined);
    check("provider recorded groq", res.meta?.provider === "groq");
  }

  // ---- T3b: all providers failed -> conservative UNCONFIRMED --------------
  {
    console.log("\nT3b all providers failed -> conservative UNCONFIRMED");
    const vision = visionMock({
      registration_no: null,
      product_name: null,
      active_ingredient: null,
      confidence: "low",
      provider: null,
    });
    const res = await runScan(
      { ocrTextOverride: "", lang: "en" }, // empty OCR -> miss -> vision -> low
      { readLabel: vision }
    );
    check("vision WAS called", vision.called === true);
    check("status UNCONFIRMED", res.status === "UNCONFIRMED", res.status);
    check("confidence low", res.confidence === "low");
    check("conservative message", /Do not use until checked/i.test(res.message || ""));
    check("no dosage/verify", res.verify === undefined && res.dosages === undefined);
  }

  // ---- T4: banned product via exact match -> BANNED, no dosage ------------
  {
    console.log("\nT4 banned via exact match -> BANNED");
    const vision = visionMock({ confidence: "low", provider: null });
    const res = await runScan(
      { ocrTextOverride: "Endosulfan 35% EC\nReg No ETH-INS-0009/05", lang: "en" },
      { readLabel: vision }
    );
    check("status BANNED", res.status === "BANNED", res.status);
    check("matchTier 1", res.matchTier === 1);
    check("vision NOT called", vision.called === false);
    check("banned withholds safety", res.verify?.safety === null);
    check("banned withholds dosages", (res.verify?.dosages?.length ?? 0) === 0);
  }

  // ---- Unit checks: aiClient with no keys, and prompt constraints ----------
  {
    console.log("\nUnit: aiClient falls through to low when no keys set");
    const r = await readLabel("data:image/png;base64,iVBORw0KGgo="); // tiny, no keys in .env
    check("returns low confidence", r.confidence === "low");
    check("provider null", r.provider === null);
    check("no dosage keys on result", !("dosage" in r) && !("first_aid" in r));
    check("prompt forbids inference", /Do NOT infer/.test(VISION_PROMPT));
  }

  // ---- Unit: matchAnchor tiers & similarity -------------------------------
  {
    console.log("\nUnit: matchAnchor tiers");
    const registry = [
      { id: 1, registration_no: "ETH-FUN-0142/17", product_name: "Mancozeb 80% WP", active_ingredient: "Mancozeb 800 g/kg" },
    ];
    check("tier1 exact (split tokens)", matchAnchor(["ETH", "FUN", "0142", "17"], registry).tier === 1);
    check("tier2 fuzzy name", matchAnchor(["Mancozeb 80% WP"], registry).tier === 2);
    check("tier3 miss", matchAnchor(["totally unrelated thing"], registry).tier === 3);
    check("similarity self=1", Math.abs(similarity("mancozeb", "mancozeb") - 1) < 1e-9);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness crashed:", err);
  process.exit(1);
});
