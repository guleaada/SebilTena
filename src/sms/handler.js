import { db as defaultDb } from "../db.js";
import { config } from "../config.js";
import { t, normalizeLang } from "../localize.js";
import { verifyNumber as defaultVerify } from "../verify.js";
import { getDosage as defaultGetDosage } from "../dosage.js";
import { getFirstAid as defaultGetFirstAid } from "../firstaid.js";
import { detectEncoding, segmentCount, fitToSegments } from "./encoding.js";
import { parseCommand } from "./commands.js";
import { resolveCrop } from "./crops.js";
import { rateLimiter as defaultLimiter } from "./rateLimit.js";
import { createSmsClient } from "./client.js";
import * as T from "./templates.js";

// ---------------------------------------------------------------------------
// SMS INBOUND HANDLER (M5). SMS is a different transport, not different logic:
// every verdict comes from verify.js, every dose from dosage.js, every first-aid
// step from firstaid.js (codes) -> reviewed aid.* strings. Nothing safety-bearing
// is defined here. Verdict-first, fitted to segments, logged, rate-limited
// (except emergency). Dependency-injectable so tests run offline. See SAFETY.md.
// ---------------------------------------------------------------------------

const defaultClient = createSmsClient();

function sanitize(text) {
  let s = String(text || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > config.smsInboundMaxChars) s = s.slice(0, config.smsInboundMaxChars);
  return s;
}

async function getUser(db, phone) {
  const r = await db.execute({ sql: "SELECT * FROM sms_users WHERE phone = ?", args: [phone] });
  return r.rows[0] || null;
}
async function touchUser(db, phone, nowIso) {
  await db.execute({
    sql: `INSERT INTO sms_users (phone, last_seen) VALUES (?, ?)
          ON CONFLICT(phone) DO UPDATE SET last_seen = excluded.last_seen`,
    args: [phone, nowIso],
  });
}
async function setLang(db, phone, lang, nowIso) {
  await db.execute({
    sql: `INSERT INTO sms_users (phone, lang, last_seen) VALUES (?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET lang = excluded.lang, last_seen = excluded.last_seen`,
    args: [phone, lang, nowIso],
  });
}
async function setLastVerified(db, phone, product, nowIso) {
  await db.execute({
    sql: `UPDATE sms_users SET last_reg_no = ?, last_pesticide_id = ?, last_active_ingredient = ?, last_verified_at = ?
          WHERE phone = ?`,
    args: [product.registration_no, product.id, product.active_ingredient, nowIso, phone],
  });
}
async function getAgent(db, region) {
  if (region) {
    const r = await db.execute({ sql: "SELECT name, phone FROM extension_agents WHERE region = ? LIMIT 1", args: [region] });
    if (r.rows.length) return r.rows[0];
  }
  const r = await db.execute("SELECT name, phone FROM extension_agents LIMIT 1");
  return r.rows[0] || null;
}

async function logSms(db, { regNo, pesticideId, status, confidence, region, lang }) {
  try {
    await db.execute({
      sql: `INSERT INTO scans
        (registration_no_read, matched_pesticide_id, result_status, confidence, lat, lon, region, language, channel)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [regNo ?? null, pesticideId ?? null, status, confidence ?? null, null, null, region ?? null, lang ?? null, "sms"],
    });
  } catch (err) {
    console.error("sms log failed:", err?.message || err);
  }
}

/**
 * Handle one inbound SMS. Sends replies via deps.client and returns them.
 * @param {{from,text,to?,linkId?,date?}} inbound
 * @param {object} deps  { db, client, verifyNumber, getDosage, getFirstAid, rateLimiter, now }
 */
export async function handleInbound(inbound, deps = {}) {
  const db = deps.db ?? defaultDb;
  const client = deps.client ?? defaultClient;
  const verify = deps.verifyNumber ?? defaultVerify;
  const getDosage = deps.getDosage ?? defaultGetDosage;
  const getFirstAid = deps.getFirstAid ?? defaultGetFirstAid;
  const limiter = deps.rateLimiter ?? defaultLimiter;
  const nowMs = deps.now ? deps.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const from = String(inbound.from || "").trim();
  const text = sanitize(inbound.text);
  const cmd = parseCommand(text);
  const isEmergency = cmd.type === "HELP" || cmd.type === "ROUTE";

  const user = await getUser(db, from);
  const knownLang = user?.lang ? normalizeLang(user.lang) : null;
  const region = user?.region || null;

  // --- Cost guard: rate-limit everything EXCEPT emergency ---
  if (!isEmergency) {
    if (limiter.isLimited(from, nowMs)) {
      const lang = knownLang || "en";
      await logSms(db, { status: "RATE_LIMITED", region, lang });
      return send(client, db, from, [T.rateLimitedText(lang)], { status: "RATE_LIMITED", region, lang, log: false });
    }
    limiter.record(from, nowMs);
  }
  await touchUser(db, from, nowIso);

  switch (cmd.type) {
    case "LANG": {
      if (!cmd.lang) {
        const lang = knownLang || "en";
        await logSms(db, { status: "SMS_LANG", region, lang });
        return send(client, db, from, [T.langBadText(lang)], { status: "SMS_LANG", region, lang });
      }
      await setLang(db, from, cmd.lang, nowIso);
      return send(client, db, from, [T.langSetText(cmd.lang, cmd.lang)], { status: "SMS_LANG", region, lang: cmd.lang });
    }

    case "HELP":
    case "ROUTE": {
      const lang = knownLang || "en";
      if (cmd.type === "HELP" && !cmd.route) {
        await logSms(db, { status: "EMERGENCY", region, lang });
        return send(client, db, from, [T.emergencyMenuText(lang)], { status: "EMERGENCY", region, lang });
      }
      return emergencyReply({ db, client, getFirstAid, from, route: cmd.route, user, lang, region, nowMs });
    }

    case "CROP": {
      const lang = knownLang || "en";
      const cropKey = resolveCrop(cmd.crop);
      if (!cropKey) {
        await logSms(db, { status: "SMS_DOSE", region, lang });
        return send(client, db, from, [t(lang, "sms.crop_unknown")], { status: "SMS_DOSE", region, lang });
      }
      const fresh = user?.last_verified_at && nowMs - Date.parse(user.last_verified_at) <= config.smsSessionTtlMin * 60_000;
      if (!user?.last_pesticide_id || !fresh) {
        await logSms(db, { status: "SMS_DOSE", region, lang });
        return send(client, db, from, [T.noProductText(lang)], { status: "SMS_DOSE", region, lang });
      }
      const dose = await getDosage(user.last_pesticide_id, cropKey, lang);
      const cropLabel = t(lang, `crop.${cropKey}`);
      await logSms(db, { regNo: user.last_reg_no, pesticideId: user.last_pesticide_id, status: dose.covered ? "SMS_DOSE" : "SMS_DOSE_UNCOVERED", region, lang });
      return send(client, db, from, [T.doseText(dose, cropLabel, lang)], { status: "SMS_DOSE", region, lang });
    }

    case "REGNO": {
      const result = await verify(cmd.regNo, knownLang || "en");
      if (result.status === "VERIFIED" && result.product) {
        await setLastVerified(db, from, result.product, nowIso);
      }
      await logSms(db, {
        regNo: cmd.regNo, pesticideId: result.product?.id, status: result.status, confidence: "high", region, lang: result.lang,
      });
      // Unknown language -> bilingual (en + am) verdict + LANG invite.
      const message = knownLang ? T.verdictText(result, knownLang) : T.bilingualVerdict(result);
      return send(client, db, from, [message], { status: result.status, region, lang: knownLang || "en" });
    }

    default: {
      // Not parseable -> short help. Unknown language -> en help + am hint.
      const lang = knownLang || "en";
      const msg = knownLang ? T.helpText(lang) : `${T.helpText("en")} / ${T.helpText("am")}`;
      await logSms(db, { status: "SMS_HELP", region, lang });
      return send(client, db, from, [msg], { status: "SMS_HELP", region, lang });
    }
  }
}

// Emergency first-aid by SMS (M5 Part B). Never gates on identifying a product;
// uses the recent VERIFIED product's steps if fresh, else the universal steps.
// Steps come from firstaid.js as CODES -> reviewed aid.* strings. No prose here.
async function emergencyReply({ db, client, getFirstAid, from, route, user, lang, region, nowMs }) {
  const fresh = user?.last_verified_at && nowMs - Date.parse(user.last_verified_at) <= config.smsSessionTtlMin * 60_000;
  const ingredient = fresh ? user.last_active_ingredient : null;

  const fa = await getFirstAid(ingredient || "", route, lang); // codes only
  const stepTexts = (fa.steps || []).map((c) => t(lang, `aid.${c}`));
  const seekText = t(lang, "aid.aid_seek_help");

  const agent = await getAgent(db, region);
  const call = T.callLine(agent?.phone, config.poisonCentre, lang);

  const messages = T.packEmergency({ steps: stepTexts, seekText, call, lang });
  await logSms(db, { pesticideId: fresh ? user.last_pesticide_id : null, status: "EMERGENCY", region, lang });
  return send(client, db, from, messages, { status: "EMERGENCY", region, lang });
}

// Fit each outbound to <=2 segments, log encoding + segment count, send.
async function send(client, db, to, rawMessages, ctx) {
  const out = [];
  for (const raw of rawMessages) {
    const message = fitToSegments(raw, 2, ctx.lang);
    const encoding = detectEncoding(message);
    const segments = segmentCount(message);
    console.log(`[sms:out] to=${to} status=${ctx.status} enc=${encoding} seg=${segments} chars=${message.length}`);
    out.push({ message, encoding, segments });
    try {
      await client.sendSms({ to, message });
    } catch (err) {
      console.error("sms send failed:", err?.message || err);
    }
  }
  return { to, status: ctx.status, lang: ctx.lang, replies: out };
}
