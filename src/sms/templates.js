import { t } from "../localize.js";

// ---------------------------------------------------------------------------
// SMS reply builders. VERDICT-FIRST always (Section 0 rule 2): the danger word
// leads every message so it survives truncation or a dropped segment.
//
// These templates are localized UI copy (sms.* in /locales). They NEVER define a
// dosage, first-aid, or safety value — those come from verify.js / dosage.js /
// firstaid.js (+ the reviewed aid.* strings). See SAFETY.md.
// ---------------------------------------------------------------------------

const STATUS_SMS = {
  VERIFIED: "verified",
  UNREGISTERED: "unregistered",
  BANNED: "banned",
  EXPIRED: "expired",
  SUSPENDED: "suspended",
  UNCONFIRMED: "unconfirmed",
};

function fill(str, vars = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

// Verdict-first status reply (unfitted; the handler fits to segments).
export function verdictText(verifyResult, lang) {
  const key = STATUS_SMS[verifyResult.status] || "unconfirmed";
  let s = t(lang, `sms.${key}`);
  if (verifyResult.status === "VERIFIED" && verifyResult.product) {
    s = fill(s, { product: verifyResult.product.product_name });
  }
  return s;
}

// Bilingual (en + am) reply for a number with no language preference yet.
export function bilingualVerdict(verifyResult) {
  const en = verdictText(verifyResult, "en");
  const am = verdictText(verifyResult, "am");
  return `${en} / ${am} (LANG am)`;
}

export function doseText(dose, cropLabel, lang) {
  if (!dose || !dose.covered) {
    return fill(t(lang, "sms.crop_uncovered"), { crop: cropLabel });
  }
  const key = dose.pre_harvest_interval_days != null ? "sms.dose" : "sms.dose_nophi";
  return fill(t(lang, key), {
    crop: cropLabel,
    dose: dose.dose_per_unit,
    phi: dose.pre_harvest_interval_days,
  });
}

export const helpText = (lang) => t(lang, "sms.help");
export const noProductText = (lang) => t(lang, "sms.no_product");
export const rateLimitedText = (lang) => t(lang, "sms.rate_limited");
export const emergencyMenuText = (lang) => t(lang, "sms.emergency_menu");
export const langSetText = (lang, langName) => fill(t(lang, "sms.lang_set"), { lang: langName });
export const langBadText = (lang) => t(lang, "sms.lang_bad");

export function callLine(agentPhone, poison, lang) {
  return fill(t(lang, "sms.call_line"), { agent: agentPhone || "-", poison: poison || "-" });
}
