// M8 Part E — deploy/config test suite. Black-box: spawns the REAL server in
// different env configurations and proves the production posture — the boot-gate
// + preflight FAIL CLOSED, and a STAGING build comes up secure and clearly a
// demonstration. This is the CI-runnable proof of Part E (Fly access not
// required; it exercises the exact code the image runs).
//
//   node scripts/test-deploy-config.js
//
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const strong = () => crypto.randomBytes(24).toString("hex"); // 48 chars, non-dev

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn the server. mode 'exit' resolves when it exits (for refuse cases); mode
// 'boot' resolves once /api/health answers.
function runServer(env, { mode = "boot", port } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", ["src/server.js"], {
      cwd: ROOT, env: { ...process.env, NODE_ENV: "", STAGING: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    if (mode === "exit") {
      child.on("exit", (code) => resolve({ code, out, child }));
    } else {
      (async () => {
        for (let i = 0; i < 50; i++) {
          try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return resolve({ code: null, out, child }); } catch {}
          await sleep(150);
        }
        resolve({ code: null, out, child });
      })();
    }
  });
}

async function main() {
  console.log("Fail closed — the boot-gate + preflight refuse insecure/uncleared starts");

  // 1. Cleared production build (NODE_ENV=production, no STAGING) + unreviewed
  //    first-aid -> MUST refuse to start.
  const r1 = await runServer({ NODE_ENV: "production", DEVICE_TOKEN_SECRET: strong(), ADMIN_TOKEN: strong() }, { mode: "exit" });
  check("cleared production + unreviewed first-aid -> exit non-zero", r1.code === 1, `code=${r1.code}`);
  check("...and says NOT CLEARED / refusing", /UNREVIEWED|refusing to start/i.test(r1.out));

  // 2. Hardened deploy missing DEVICE_TOKEN_SECRET -> MUST refuse.
  const r2 = await runServer({ STAGING: "true", ADMIN_TOKEN: strong() }, { mode: "exit" });
  check("STAGING + missing DEVICE_TOKEN_SECRET -> exit non-zero", r2.code === 1, `code=${r2.code}`);
  check("...names DEVICE_TOKEN_SECRET", /DEVICE_TOKEN_SECRET/.test(r2.out));

  // 3. Hardened deploy with a weak/dev ADMIN_TOKEN -> MUST refuse.
  const r3 = await runServer({ STAGING: "true", DEVICE_TOKEN_SECRET: strong(), ADMIN_TOKEN: "dev-surveillance-token" }, { mode: "exit" });
  check("STAGING + weak ADMIN_TOKEN (dev value) -> exit non-zero", r3.code === 1, `code=${r3.code}`);
  check("...names ADMIN_TOKEN", /ADMIN_TOKEN/.test(r3.out));

  console.log("\nA STAGING demonstration build comes up secure + clearly a demo");
  const PORT = 3211;
  const ADMIN = strong();
  const boot = await runServer(
    { STAGING: "true", DEVICE_TOKEN_SECRET: strong(), ADMIN_TOKEN: ADMIN, AT_WEBHOOK_SECRET: strong(), PORT: String(PORT) },
    { mode: "boot", port: PORT }
  );
  const BASE = `http://localhost:${PORT}`;
  const j = async (p, opts) => (await fetch(`${BASE}${p}`, opts)).json();
  const s = async (p, opts) => (await fetch(`${BASE}${p}`, opts)).status;
  try {
    check("demonstration build STARTS (health 200)", boot.code === null && (await fetch(`${BASE}/api/health`)).ok);
    check("boot log announces the DEMONSTRATION / NOT CLEARED path", /DEMONSTRATION|NOT CLEARED/i.test(boot.out));

    const health = await j("/api/health");
    check("health reports staging + milestone M8", health.staging === true && health.milestone === "M8");
    check("app-config reports staging:true", (await j("/api/app-config")).staging === true);
    check("app-config reports SMS disabled (no AT keys)", (await j("/api/app-config")).smsEnabled === false);

    console.log("\n  Undiscoverable posture");
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    check("robots.txt disallows all", /User-agent:\s*\*/.test(robots) && /Disallow:\s*\//.test(robots));
    const rootHdrs = (await fetch(`${BASE}/`)).headers;
    check("whole-app X-Robots-Tag: noindex", /noindex/i.test(rootHdrs.get("x-robots-tag") || ""));

    console.log("\n  Surveillance gate + secrets");
    check("surveillance 401 without ADMIN_TOKEN", (await s("/api/surveillance/districts")) === 401);
    const gated = await fetch(`${BASE}/api/surveillance/districts`, { headers: { "x-admin-token": ADMIN } });
    check("surveillance 200 with ADMIN_TOKEN", gated.status === 200);
    check("gated surveillance carries noindex + no-store", /noindex/i.test(gated.headers.get("x-robots-tag") || "") && /no-store/i.test(gated.headers.get("cache-control") || ""));

    console.log("\n  SMS webhook rejects unauthenticated posts (secret set)");
    check("SMS webhook without secret -> 401", (await fetch(`${BASE}/api/sms/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "+251900000000", text: "HELP" }) })).status === 401);

    console.log("\n  Verdict path works end-to-end against the DB");
    const banned = await j("/api/verify-number", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationNo: "ETH-INS-0009/05", lang: "en" }) });
    check("a banned product returns BANNED", banned.status === "BANNED", banned.status);
    const unknown = await j("/api/verify-number", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationNo: "TOTALLY-FAKE-99/9", lang: "en" }) });
    check("an unknown reg-no online returns UNREGISTERED", unknown.status === "UNREGISTERED", unknown.status);
    const verified = await j("/api/verify-number", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationNo: "ETH-FUN-0142/17", lang: "en" }) });
    check("a registered product returns VERIFIED + DB dosage", verified.status === "VERIFIED" && (verified.dosages?.length ?? 0) > 0);

    console.log("\n  Write surface still gated (device token required)");
    check("scans/sync without a device token -> 401", (await s("/api/scans/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scans: [] }) })) === 401);
  } finally {
    boot.child?.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
