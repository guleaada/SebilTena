// M7.5 Part B — write-side anti-abuse. Black-box: spawns the REAL server with
// low limits and proves the app-issued write token gates /api/scans/sync, that
// the token is opaque + PII-free + never stored with scans (anonymity intact),
// that batches are capped and the write surface is rate-limited, and that the
// farmer-facing verdict/emergency paths are NEVER throttled.
//
//   node scripts/test-write-gate.js
//
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { db, initSchema } from "../src/db.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3205;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}
const post = (p, body, headers = {}) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
async function register() {
  const r = await post("/api/register-device");
  return r.ok ? (await r.json()).token : null;
}
const scan = (uuid, reg = "FAKE-9999/99") => ({ uuid, registration_no_read: reg, result_status: "UNCONFIRMED" });

async function main() {
  await initSchema();
  await db.execute("DELETE FROM scans");

  const child = spawn("node", ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DEVICE_TOKEN_SECRET: "test-write-secret",
      SYNC_SCANS_PER_HOUR_PER_TOKEN: "2",
      SYNC_CALLS_PER_HOUR_PER_IP: "1000",
      DEVICE_REG_PER_HOUR_PER_IP: "8",
      SYNC_MAX_BATCH: "5",
    },
    stdio: "ignore",
  });

  try {
    if (!(await waitHealthy())) { console.error("server did not start"); process.exit(1); }

    console.log("Sync requires an app-issued write token");
    check("no token -> 401", (await post("/api/scans/sync", { scans: [scan("w-notok")] })).status === 401);
    check("garbage token -> 401", (await post("/api/scans/sync", { scans: [scan("w-bad")] }, { "x-device-token": "v1.abc.def" })).status === 401);

    console.log("\nregister-device issues an opaque, PII-free token");
    const tokenHappy = await register();
    check("register returns a token", typeof tokenHappy === "string" && tokenHappy.startsWith("v1."));
    const payload = JSON.parse(Buffer.from(tokenHappy.split(".")[1], "base64url").toString("utf8"));
    check("token payload carries NO identity (only iat/exp/n)", Object.keys(payload).sort().join(",") === "exp,iat,n", Object.keys(payload).join(","));
    check("token payload has no phone/id/device/ip field", !("phone" in payload) && !("id" in payload) && !("device" in payload) && !("ip" in payload));

    console.log("\nvalid token -> 200, and the token is NOT stored with the scan (anonymity)");
    const ok = await post("/api/scans/sync", { scans: [scan("w-ok", "GHOST-1/1")] }, { "x-device-token": tokenHappy });
    check("valid token sync -> 200", ok.status === 200);
    const row = (await db.execute({ sql: "SELECT * FROM scans WHERE client_uuid=?", args: ["w-ok"] })).rows[0];
    check("scan row was written", !!row);
    check("no token/device column on the row", row && !("device_token" in row) && !("token" in row) && !("device_id" in row), row && Object.keys(row).join(","));
    check("the token string appears NOWHERE on the row", row && !JSON.stringify(row).includes(tokenHappy));

    console.log("\noversized batch is rejected, not truncated");
    const tokenBig = await register();
    const big = { scans: Array.from({ length: 6 }, (_, i) => scan(`w-big-${i}`)) }; // > SYNC_MAX_BATCH (5)
    const over = await post("/api/scans/sync", big, { "x-device-token": tokenBig });
    check("batch of 6 (> cap 5) -> 413", over.status === 413, String(over.status));
    check("no rows written for the rejected oversized batch", (await db.execute("SELECT COUNT(*) n FROM scans WHERE client_uuid LIKE 'w-big-%'")).rows[0].n == 0);

    console.log("\nper-token rate limit (budget is in SCANS)");
    const tokenRL = await register();
    const s1 = await post("/api/scans/sync", { scans: [scan("w-rl-1"), scan("w-rl-2")] }, { "x-device-token": tokenRL }); // 2 scans == limit
    check("first batch (2 scans, == limit) -> 200", s1.status === 200, String(s1.status));
    const s2 = await post("/api/scans/sync", { scans: [scan("w-rl-3")] }, { "x-device-token": tokenRL }); // over budget
    check("next scan over the hourly token budget -> 429", s2.status === 429, String(s2.status));

    console.log("\nfarmer-facing paths are NEVER throttled");
    let throttled = 0;
    for (let i = 0; i < 30; i++) {
      const v = await post("/api/verify-number", { registrationNo: "FAKE-0/0", lang: "en" });
      const sc = await post("/api/scan", { imageBase64: "", lang: "en" });
      if (v.status === 429 || sc.status === 429) throttled++;
    }
    check("verify-number + scan never return 429 (60 calls)", throttled === 0, `throttled=${throttled}`);
    check("emergency-bundle never throttled", (await fetch(`${BASE}/api/emergency-bundle`)).status !== 429);

    console.log("\nregister-device is itself rate-limited per IP");
    let got429 = false;
    for (let i = 0; i < 20; i++) { if ((await post("/api/register-device")).status === 429) { got429 = true; break; } }
    check("device registration eventually rate-limits (per IP)", got429);

    console.log("\nissuance is audited to events (no PII, no token value)");
    const ev = (await db.execute("SELECT payload FROM events WHERE type='device_registered' LIMIT 1")).rows[0];
    check("device_registered logged", !!ev);
    check("issuance event carries no token/PII", ev && (ev.payload == null || ev.payload === "{}" || !/v1\./.test(ev.payload)), ev && ev.payload);
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
