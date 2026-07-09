// M5 SMS tests — offline, mock Africa's Talking client, real seeded DB.
//   node scripts/test-sms.js
//
import fsSync from "node:fs";
import { db, initSchema } from "../src/db.js";
import { detectEncoding, segmentCount, fitToSegments } from "../src/sms/encoding.js";
import { handleInbound } from "../src/sms/handler.js";
import { createMockSmsClient } from "../src/sms/client.js";
import { createRateLimiter } from "../src/sms/rateLimit.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

let phoneSeq = 1000;
const newPhone = () => `+2519110${phoneSeq++}`;

// Run one inbound message; returns the sent messages + result.
async function sms(text, opts = {}) {
  const client = opts.client || createMockSmsClient();
  const res = await handleInbound(
    { from: opts.from, text },
    { client, rateLimiter: opts.limiter, now: opts.now }
  );
  return { res, sent: client.sent, client };
}

// A phone with a preset language.
async function withLang(lang) {
  const from = newPhone();
  await sms(`LANG ${lang}`, { from });
  return from;
}

async function main() {
  await initSchema();
  await db.execute("DELETE FROM sms_users"); // deterministic

  // ---- Section 0: encoding --------------------------------------------------
  console.log("\nEncoding");
  check("English (Latin) -> GSM7", detectEncoding("BANNED. Do NOT use this product.") === "GSM7");
  check("Amharic (Ethiopic) -> UCS2", detectEncoding("የተከለከለ! አይጠቀሙ።") === "UCS2");
  check("Somali (Latin) -> GSM7", detectEncoding("DHORKAMEERA! Hin fayyadamin.") === "GSM7");
  check("Afaan Oromo (Latin) -> GSM7", detectEncoding("Galmaa'eera: Mancozeb.") === "GSM7");
  check("short Amharic = 1 segment", segmentCount("የተከለከለ! አይጠቀሙ።") === 1);
  check("GSM7 <=160 = 1 segment", segmentCount("A".repeat(160)) === 1);
  check("GSM7 161 = 2 segments", segmentCount("A".repeat(161)) === 2);
  check("UCS2 71 chars = 2 segments", segmentCount("ሀ".repeat(71)) === 2);
  check("fit trims from the end (verdict kept)", fitToSegments("BANNED. " + "x".repeat(400), 1, "en").startsWith("BANNED."));

  // ---- Part A: verification -------------------------------------------------
  console.log("\nVerification (verdict-first)");
  {
    const from = await withLang("am");
    const { sent } = await sms("ETH-FUN-0142/17", { from });
    const m = sent.at(-1).message;
    check("VERIFIED reply names product", /Mancozeb 80% WP/.test(m), m);
    check("VERIFIED reply is Amharic/UCS2", detectEncoding(m) === "UCS2");
    check("VERIFIED reply <=2 segments", segmentCount(m) <= 2);
  }
  {
    const from = await withLang("am");
    const { sent } = await sms("ETH-INS-0009/05", { from }); // Endosulfan, banned
    const m = sent.at(-1).message;
    check("BANNED verdict-first (Amharic danger word leads)", m.startsWith("የተከለከለ"), m);
    check("BANNED reply carries no dose", !/kg|ml|litre|ሄክታር/.test(m));
  }
  {
    const from = await withLang("en");
    const { sent } = await sms("FAKE-0000/00", { from });
    check("UNREGISTERED danger-first", sent.at(-1).message.startsWith("NOT REGISTERED"), sent.at(-1).message);
  }
  {
    const from = await withLang("en");
    const { sent } = await sms("ETH-INS-0057/13", { from }); // Dimethoate, expired
    check("EXPIRED caution-first", sent.at(-1).message.startsWith("EXPIRED"), sent.at(-1).message);
  }
  {
    // Unknown language -> bilingual verdict + LANG invite.
    const { sent } = await sms("ETH-INS-0009/05", { from: newPhone() });
    const m = sent.at(-1).message;
    check("unknown-lang verdict is bilingual (en+am)", /BANNED/.test(m) && /የተከለከለ/.test(m), m);
    check("unknown-lang verdict invites LANG", /LANG am/.test(m));
  }

  // ---- No fuzzy over SMS ----------------------------------------------------
  console.log("\nNo fuzzy match / unknown");
  {
    const from = await withLang("en");
    const { sent } = await sms("Mancozeb", { from }); // product NAME, not a reg no
    check("product name (no digits) -> help, not a verdict", /registration number/.test(sent.at(-1).message));
  }
  {
    const from = await withLang("en");
    const { sent } = await sms("XYZ-999", { from }); // reg-like but unknown
    const m = sent.at(-1).message;
    check("unknown reg no -> UNREGISTERED, never a dose", m.startsWith("NOT REGISTERED") && !/kg|ml|litre/.test(m), m);
  }

  // ---- Dosage over SMS ------------------------------------------------------
  console.log("\nDosage");
  {
    const from = await withLang("en");
    await sms("ETH-FUN-0142/17", { from });          // verify Mancozeb first
    const { sent } = await sms("CROP potato", { from });
    check("CROP after verify returns the DB dose", /2\.5 kg per hectare/.test(sent.at(-1).message), sent.at(-1).message);
    check("CROP dose includes pre-harvest interval", /7 days/.test(sent.at(-1).message));
  }
  {
    const from = await withLang("en");
    await sms("ETH-FUN-0142/17", { from });
    const { sent } = await sms("CROP coffee", { from }); // approved crop, no dosage row
    check("uncovered crop -> not approved, no invented dose", /Not approved/.test(sent.at(-1).message) && !/kg|ml/.test(sent.at(-1).message));
  }
  {
    const from = await withLang("en");
    const { sent } = await sms("CROP potato", { from }); // no prior verify
    check("CROP with no product context -> asks for reg number first", /registration number first/.test(sent.at(-1).message));
  }

  // ---- Rate limiting (non-emergency) ---------------------------------------
  console.log("\nRate limiting");
  {
    const from = newPhone();
    const limiter = createRateLimiter({ max: 3 });
    for (let i = 0; i < 3; i++) await sms("ETH-INS-0009/05", { from, limiter });
    const { sent } = await sms("ETH-INS-0009/05", { from, limiter });
    check("4th message over limit -> rate-limited notice", /Too many messages/.test(sent.at(-1).message));
    // HELP still works while limited (bypass)
    const { sent: helpSent } = await sms("HELP", { from, limiter });
    check("HELP bypasses the rate limiter", /FIRST AID/.test(helpSent.at(-1).message), helpSent.at(-1).message);
  }

  // ---- Part B: Emergency first aid -----------------------------------------
  console.log("\nEmergency (Part B)");
  {
    const { sent } = await sms("HELP", { from: newPhone() });
    check("HELP -> route menu", /FIRST AID/.test(sent.at(-1).message) && /SWALLOWED/.test(sent.at(-1).message));
  }
  {
    // Bare route word, no product context -> universal steps.
    const from = await withLang("en");
    const { sent } = await sms("SWALLOWED", { from });
    const first = sent[0].message;
    check("bare route -> first aid delivered", sent.length >= 1 && /1\./.test(first), first);
    check("first message contains aid_seek_help", /health centre/i.test(first), first);
    check("first message contains a phone number", /\+251/.test(first), first);
    check("emergency <= 2 messages", sent.length <= 2);
    for (const m of sent) check("each emergency msg <= 2 segments", segmentCount(m.message) <= 2, m.message);
  }
  {
    // HELP SWALLOWED (route on the HELP line).
    const from = await withLang("en");
    const { sent } = await sms("HELP SWALLOWED", { from });
    check("HELP <route> -> first aid", /health centre/i.test(sent[0].message));
  }
  {
    // Amharic bare route word (ተውጦ = swallowed) -> Amharic first aid.
    const from = await withLang("am");
    const { sent } = await sms("ተውጦ", { from });
    check("Amharic route word recognized", /ጤና ጣቢያ/.test(sent[0].message), sent[0].message);
    check("Amharic emergency is UCS2", detectEncoding(sent[0].message) === "UCS2");
  }
  {
    // Afaan Oromo route word (liqimse = swallowed).
    const from = await withLang("om");
    const { sent } = await sms("liqimse", { from });
    check("Afaan Oromo route word recognized", /buufata fayyaatti/i.test(sent[0].message), sent[0].message);
  }
  {
    // Product context: verify Mancozeb, then emergency uses its steps.
    const from = await withLang("en");
    await sms("ETH-FUN-0142/17", { from });
    const { sent } = await sms("SKIN", { from });
    check("emergency with product context still delivers + seek+phone", /health centre/i.test(sent[0].message) && /\+251/.test(sent[0].message));
  }
  {
    // Emergency is never rate-limited (fresh limiter already exhausted).
    const from = newPhone();
    const limiter = createRateLimiter({ max: 1 });
    await sms("ETH-INS-0009/05", { from, limiter }); // uses the one allowance
    const { sent } = await sms("SWALLOWED", { from, limiter }); // must still work
    check("SWALLOWED bypasses rate limit", /health centre/i.test(sent[0].message));
  }
  {
    // Emergency logged with result_status EMERGENCY.
    const before = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms' AND result_status='EMERGENCY'")).rows[0].n);
    await sms("BREATHED", { from: await withLang("en") });
    const after = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms' AND result_status='EMERGENCY'")).rows[0].n);
    check("emergency logged as EMERGENCY", after > before);
  }

  // ---- Logging --------------------------------------------------------------
  console.log("\nLogging");
  {
    const before = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms'")).rows[0].n);
    const from = await withLang("en");
    await sms("ETH-INS-0009/05", { from });
    const after = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms'")).rows[0].n);
    check("SMS interaction logged to scans(channel=sms)", after > before);
  }

  // ---- Part C: provenance + encoding-by-language ---------------------------
  console.log("\nProvenance & encoding (Part C)");
  {
    // No safety prose may be defined in the SMS layer — dose/first-aid text must
    // come from verify.js / dosage.js / firstaid.js (+ aid.* locale), never here.
    const dir = new URL("../src/sms/", import.meta.url);
    const files = fsSync.readdirSync(dir).filter((f) => f.endsWith(".js"));
    const FORBIDDEN = /kg per hectare|ml per litre|induce vomiting|Do not make the person|health centre|Rinse the (skin|eye)/i;
    let leaks = 0;
    for (const f of files) {
      const src = fsSync.readFileSync(new URL(f, dir), "utf8");
      if (FORBIDDEN.test(src)) { leaks++; console.error(`   prose leak in ${f}`); }
    }
    check("no dose/first-aid prose defined in src/sms/*", leaks === 0);
  }
  {
    // Every emergency step text traces to an aid.* locale string (firstaid codes).
    const { t } = await import("../src/localize.js");
    const from = await withLang("en");
    const { sent } = await sms("EYES", { from });
    const seek = t("en", "aid.aid_seek_help");
    const rinse = t("en", "aid.aid_rinse_eyes");
    check("emergency step text == aid.* locale (traceable to firstaid.js)",
      sent[0].message.includes(seek) && sent[0].message.includes(rinse), sent[0].message);
  }
  {
    // Latin-script languages -> GSM-7; Ge'ez-script -> UCS-2.
    const omFrom = await withLang("om");
    const { sent: omSent } = await sms("ETH-INS-0009/05", { from: omFrom });
    check("Afaan Oromo reply detected as GSM-7", detectEncoding(omSent.at(-1).message) === "GSM7", omSent.at(-1).message);
    const aaFrom = await withLang("aa"); // Afar is Latin
    const { sent: aaSent } = await sms("ETH-INS-0009/05", { from: aaFrom });
    check("Afar reply detected as GSM-7", detectEncoding(aaSent.at(-1).message) === "GSM7", aaSent.at(-1).message);
    const amFrom = await withLang("am");
    const { sent: amSent } = await sms("ETH-INS-0009/05", { from: amFrom });
    check("Amharic reply detected as UCS-2 and <=2 segments",
      detectEncoding(amSent.at(-1).message) === "UCS2" && segmentCount(amSent.at(-1).message) <= 2);
    // encoding.js classifies Ge'ez (am, ti) as UCS-2 regardless of locale content.
    // ti replies are currently English (stub -> en fallback), so we assert the
    // classifier on Ge'ez text directly rather than on a ti reply.
    check("encoding classifies Ge'ez (ti/am script) as UCS-2", detectEncoding("ትግርኛ ጽሑፍ") === "UCS2");
  }
  {
    // LANG aa works; Afar route word recognized (stub -> English first-aid text).
    const from = newPhone();
    await sms("LANG aa", { from });
    const langRow = (await db.execute({ sql: "SELECT lang FROM sms_users WHERE phone=?", args: [from] })).rows[0];
    check("LANG aa persists Afar preference", langRow?.lang === "aa", JSON.stringify(langRow));
    const { sent } = await sms("liqime", { from }); // Afar swallowed (best-effort)
    check("Afar route word triggers first aid", /health centre/i.test(sent[0].message), sent[0].message);
    const bad = await sms("LANG zz", { from: newPhone() });
    check("LANG with unsupported code -> rejected", /Unknown language|Use:/.test(bad.sent.at(-1).message), bad.sent.at(-1).message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
