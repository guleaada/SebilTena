// M5 SMS tests — offline, mock Africa's Talking client, real seeded DB.
//   node scripts/test-sms.js
//
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

  // ---- Logging --------------------------------------------------------------
  console.log("\nLogging");
  {
    const before = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms'")).rows[0].n);
    const from = await withLang("en");
    await sms("ETH-INS-0009/05", { from });
    const after = Number((await db.execute("SELECT COUNT(*) n FROM scans WHERE channel='sms'")).rows[0].n);
    check("SMS interaction logged to scans(channel=sms)", after > before);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
