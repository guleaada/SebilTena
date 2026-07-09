import { t } from "../localize.js";
import { segmentCount, fitToSegments } from "./encoding.js";

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

/**
 * Pack emergency first-aid into at most TWO messages (M5 Part B). aid_seek_help
 * + the phone line are GUARANTEED to be in the FIRST message, even if earlier
 * steps must be pushed to a second message.
 * @param {{steps:string[], seekText:string, call:string, lang:string}} p
 * @returns {string[]} 1 or 2 messages
 */
export function packEmergency({ steps, seekText, call, lang }) {
  const list = seekText && !steps.includes(seekText) ? [...steps, seekText] : steps.slice();
  const render = (arr) => arr.map((s, i) => `${i + 1}. ${s}`).join(" ");
  const full = `${render(list)} ${call}`.trim();
  if (segmentCount(full) <= 2) return [full];

  // Reserve room for seek + call; greedily add the other steps before them.
  const others = list.filter((s) => s !== seekText);
  const chosen = [];
  for (const s of others) {
    const trial = `${render([...chosen, s, seekText])} ${call}`;
    if (segmentCount(trial) <= 2) chosen.push(s);
    else break;
  }
  const msg1 = `${render([...chosen, seekText])} ${call}`;
  const leftover = others.filter((s) => !chosen.includes(s));
  const messages = [fitToSegments(msg1, 2, lang)];
  if (leftover.length) messages.push(fitToSegments(render(leftover), 2, lang));
  return messages.slice(0, 2);
}
