import { config } from "./config.js";
import { db as defaultDb } from "./db.js";
import { CLEARED_SQL } from "./review.js";

// ---------------------------------------------------------------------------
// PRODUCTION PREFLIGHT (M8 Part B) — one place where every fail-closed
// condition lives, is logged together, and blocks startup. The app must REFUSE
// TO RUN INSECURELY in a hardened deployment rather than run with weak defaults.
//
// "Hardened" = a real deployment: NODE_ENV=production OR STAGING=true. Plain dev
// (`node src/server.js` with neither set) only warns, so local work is unimpeded.
//
// Two fatal families:
//   1. The first-aid release boot-gate (SAFETY.md): a CLEARED production build
//      (production, no STAGING) with unreviewed first-aid refuses to start. A
//      DEMONSTRATION build (STAGING=true) may boot — the banner + a logged
//      notice make it honestly non-cleared. We NEVER flip data to reviewed:true
//      to force a boot.
//   2. Required secrets missing or weak in a hardened deployment.
// ---------------------------------------------------------------------------

// Values that must never stand in for a real production secret.
const DEV_VALUES = new Set([
  "dev-surveillance-token", "test-write-secret", "test-gate-token", "test-write-secret",
  "changeme", "change-me", "secret", "password", "admin", "token", "dev", "test", "example",
]);
const MIN_SECRET_LEN = 16;
const isStrong = (v) =>
  typeof v === "string" && v.length >= MIN_SECRET_LEN && !DEV_VALUES.has(v.toLowerCase());

/**
 * @returns {Promise<{ok, fatal:string[], warn:string[], hardened, staging, production}>}
 *   ok=false means the caller must exit non-zero.
 */
export async function runPreflight({ dbClient = defaultDb } = {}) {
  const production = process.env.NODE_ENV === "production";
  const staging = config.staging;
  const hardened = production || staging;

  const fatal = [];
  const warn = [];

  // --- 1. First-aid release boot-gate -----------------------------------------
  // "Cleared" is the STRICTER M10 definition: reviewed AND signed (reviewed_by +
  // reviewed_at). A product flagged reviewed=1 without a named reviewer/timestamp
  // is NOT cleared — sign-off happens only through /admin/review.
  let uncleared = 0, cleared = 0, total = 0;
  try {
    total = Number((await dbClient.execute("SELECT COUNT(*) AS n FROM pesticides")).rows[0].n);
    cleared = Number((await dbClient.execute(`SELECT COUNT(*) AS n FROM pesticides WHERE ${CLEARED_SQL}`)).rows[0].n);
    uncleared = total - cleared;
  } catch (e) {
    // Cannot PROVE the data is reviewed -> fail closed on a hardened deployment.
    if (hardened) fatal.push(`Could not verify the first-aid review gate (${e?.message || e}). Failing closed.`);
  }
  if (uncleared > 0) {
    if (production && !staging) {
      fatal.push(
        `${uncleared} of ${total} product(s) are NOT CLEARED for field use (unsigned first-aid). ` +
        `A cleared production build refuses to start (SAFETY.md release gate). ` +
        `Sign each off through /admin/review; to run a clearly-labelled demonstration set STAGING=true.`
      );
    } else if (staging) {
      warn.push(
        `DEMONSTRATION build (STAGING=true): ${cleared} of ${total} products reviewed — ` +
        `${uncleared} NOT CLEARED FOR FIELD USE. Serving with the demonstration banner.`
      );
    } else {
      warn.push(`${cleared} of ${total} products reviewed; ${uncleared} not cleared for field use (dev).`);
    }
  }

  // --- 2. Required secrets (enforced only on a hardened deployment) ------------
  if (hardened) {
    if (!config.deviceTokenIssuedFromEnv) {
      fatal.push("DEVICE_TOKEN_SECRET is unset — write tokens must survive restarts and span machines. Set a strong value.");
    } else if (!isStrong(config.deviceTokenSecret)) {
      fatal.push("DEVICE_TOKEN_SECRET is too weak or a known dev value (need >=16 chars, non-dev).");
    }

    if (config.adminToken) {
      if (!isStrong(config.adminToken)) fatal.push("ADMIN_TOKEN is set but weak or a known dev value (need >=16 chars, non-dev).");
    } else {
      warn.push("ADMIN_TOKEN is unset — surveillance is LOCKED (all /api/surveillance/* return 401).");
    }

    if (config.smsWebhookSecret && !isStrong(config.smsWebhookSecret)) {
      fatal.push("AT_WEBHOOK_SECRET is set but weak or a known dev value.");
    }

    if (!process.env.TURSO_DATABASE_URL) {
      warn.push("TURSO_DATABASE_URL is unset — using a local SQLite file. Fine for local verification; set Turso for a real deploy.");
    }
    if (!(process.env.AT_API_KEY && process.env.AT_USERNAME)) {
      warn.push("SMS credentials unset — SMS sending is disabled (the webhook still rejects unauthenticated posts).");
    }
    if (!config.smsWebhookSecret) {
      warn.push("AT_WEBHOOK_SECRET unset — the SMS webhook would be UNGUARDED if SMS were enabled.");
    }
  }

  // --- Report grouped, then fail closed on any fatal --------------------------
  for (const w of warn) console.warn(`[preflight] WARN: ${w}`);
  const bar = "!".repeat(64);
  if (fatal.length) {
    console.error(`\n${bar}`);
    console.error("[preflight] FATAL — refusing to start (fail closed):");
    for (const f of fatal) console.error(`  !! ${f}`);
    console.error(`${bar}\n`);
    return { ok: false, fatal, warn, hardened, staging, production };
  }
  console.log(`[preflight] OK — ${hardened ? "hardened" : "dev"} start${staging ? " (DEMONSTRATION / STAGING)" : ""}; required secrets present.`);
  return { ok: true, fatal, warn, hardened, staging, production };
}
